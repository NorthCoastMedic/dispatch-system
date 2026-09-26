'use strict';

const totp = require('./totp');
const deviceInfo = require('./deviceInfo');
const rateLimit = require('./rateLimit');
const { loadSettings, getCategoryDefs } = require('./systemSettings');

const FAIL_LIMIT = 5;
const LOCK_MS = 15 * 60 * 1000;
const REAUTH_MS = 5 * 60 * 1000;
const PENDING_2FA_MS = 5 * 60 * 1000;

let trustProxy = false;
let pool = null;
let purgeTimer = null;

function configure(opts) {
    if (opts && opts.trustProxy != null) trustProxy = !!opts.trustProxy;
    if (opts && opts.pool) pool = opts.pool;
}

function usernameKey(name) {
    return String(name || '').trim().toLowerCase().slice(0, 64) || '-';
}

async function ensureSchema(db) {
    const conn = db || pool;
    if (!conn) throw new Error('authSecurity: no pool');
    async function addCol(sql) {
        try {
            await conn.query(sql);
        } catch (err) {
            if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    }
    await addCol("ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL");
    await addCol("ALTER TABLE users ADD COLUMN totp_pending VARCHAR(64) NULL");
    await addCol("ALTER TABLE users ADD COLUMN totp_enabled TINYINT NOT NULL DEFAULT 0");
    await conn.query(`
        CREATE TABLE IF NOT EXISTS auth_login_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          success TINYINT NOT NULL DEFAULT 0,
          username VARCHAR(64) NOT NULL DEFAULT '',
          user_id INT UNSIGNED NULL,
          ip VARCHAR(64) NOT NULL DEFAULT '',
          user_agent VARCHAR(512) NULL,
          device VARCHAR(255) NULL,
          reason VARCHAR(64) NULL,
          source VARCHAR(16) NOT NULL DEFAULT 'portal',
          PRIMARY KEY (id),
          KEY idx_all_time (created_at),
          KEY idx_all_user (username, created_at),
          KEY idx_all_success (success, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS auth_lockouts (
          username_key VARCHAR(64) NOT NULL,
          fail_count INT NOT NULL DEFAULT 0,
          locked_until DATETIME NULL,
          PRIMARY KEY (username_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    try {
        await conn.query('DROP TRIGGER IF EXISTS auth_login_logs_no_update');
        await conn.query('DROP TRIGGER IF EXISTS auth_login_logs_no_delete');
        await conn.query(`
            CREATE TRIGGER auth_login_logs_no_update
            BEFORE UPDATE ON auth_login_logs
            FOR EACH ROW
            BEGIN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'auth_login_logs immutable';
            END
        `);
        await conn.query(`
            CREATE TRIGGER auth_login_logs_no_delete
            BEFORE DELETE ON auth_login_logs
            FOR EACH ROW
            BEGIN
              IF IFNULL(@auth_login_log_purge, 0) <> 1 THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'auth_login_logs immutable';
              END IF;
            END
        `);
    } catch (err) {
        console.warn('[authSecurity] login log triggers:', err.message);
    }
}

const LOG_PURGE = [
    { table: 'auth_login_logs', key: 'retain_auth_login_logs', login: true },
    { table: 'org_settings_logs', key: 'retain_org_settings_logs' },
    { table: 'org_profile_logs', key: 'retain_org_profile_logs' },
    { table: 'rms_event_logs', key: 'retain_rms_event_logs' },
    { table: 'rms_status_logs', key: 'retain_rms_status_logs' },
    { table: 'dispatch_message_logs', key: 'retain_dispatch_message_logs' }
];

async function retentionDaysFor(key) {
    try {
        const settings = await loadSettings();
        let n = parseInt(settings.logs && settings.logs[key], 10);
        if (!Number.isFinite(n) && key === 'retain_auth_login_logs') {
            n = parseInt(settings.branding && settings.branding.login_log_retention_days, 10);
        }
        if (!Number.isFinite(n)) return 180;
        return Math.min(3650, Math.max(1, n));
    } catch (_) {
        return 180;
    }
}

async function retentionDays() {
    return retentionDaysFor('retain_auth_login_logs');
}

async function purgeExpiredLogs() {
    if (!pool) return;
    for (const item of LOG_PURGE) {
        const days = await retentionDaysFor(item.key);
        const conn = await pool.getConnection();
        try {
            if (item.login) await conn.query('SET @auth_login_log_purge = 1');
            await conn.query(
                'DELETE FROM `' + item.table + '` WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
                [days]
            );
        } catch (err) {
            console.warn('[authSecurity] purge ' + item.table + ':', err.message);
        } finally {
            if (item.login) {
                try { await conn.query('SET @auth_login_log_purge = 0'); } catch (_) { /* ignore */ }
            }
            conn.release();
        }
    }
}

function startPurgeLoop() {
    if (purgeTimer) return;
    purgeExpiredLogs().catch(() => {});
    purgeTimer = setInterval(() => {
        purgeExpiredLogs().catch(() => {});
    }, 60 * 60 * 1000);
    if (purgeTimer.unref) purgeTimer.unref();
}

function fingerprint(req) {
    return deviceInfo.fromReq(req, trustProxy);
}

async function writeLoginLog(req, fields) {
    if (!pool) return;
    const fp = fingerprint(req);
    try {
        await pool.query(
            `INSERT INTO auth_login_logs
              (success, username, user_id, ip, user_agent, device, reason, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                fields.success ? 1 : 0,
                String(fields.username || '').slice(0, 64),
                fields.userId || null,
                fp.ip,
                fp.userAgent || null,
                fp.device || null,
                fields.reason ? String(fields.reason).slice(0, 64) : null,
                fields.source || 'portal'
            ]
        );
    } catch (err) {
        console.warn('[authSecurity] write login log:', err.message);
    }
}

async function lockStatus(username) {
    const key = usernameKey(username);
    const [rows] = await pool.query(
        'SELECT fail_count, locked_until FROM auth_lockouts WHERE username_key=?',
        [key]
    );
    if (!rows.length) return { locked: false, remainSec: 0, failCount: 0 };
    const until = rows[0].locked_until ? new Date(rows[0].locked_until).getTime() : 0;
    const now = Date.now();
    if (until > now) {
        return {
            locked: true,
            remainSec: Math.max(1, Math.ceil((until - now) / 1000)),
            failCount: rows[0].fail_count || 0
        };
    }
    return { locked: false, remainSec: 0, failCount: rows[0].fail_count || 0 };
}

async function noteFail(username) {
    const key = usernameKey(username);
    const st = await lockStatus(username);
    if (st.locked) return st;
    let count = st.failCount + 1;
    let lockedUntil = null;
    if (count >= FAIL_LIMIT) {
        lockedUntil = new Date(Date.now() + LOCK_MS);
        count = 0;
    }
    await pool.query(
        `INSERT INTO auth_lockouts (username_key, fail_count, locked_until)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE fail_count=VALUES(fail_count), locked_until=VALUES(locked_until)`,
        [key, count, lockedUntil]
    );
    if (lockedUntil) {
        return { locked: true, remainSec: Math.ceil(LOCK_MS / 1000), failCount: 0 };
    }
    return { locked: false, remainSec: 0, failCount: count };
}

async function noteOk(username) {
    const key = usernameKey(username);
    await pool.query(
        'INSERT INTO auth_lockouts (username_key, fail_count, locked_until) VALUES (?, 0, NULL) ON DUPLICATE KEY UPDATE fail_count=0, locked_until=NULL',
        [key]
    );
}

async function userHas2fa(userId) {
    if (!userId || !pool) return false;
    const [rows] = await pool.query('SELECT totp_enabled FROM users WHERE id=? LIMIT 1', [userId]);
    return !!(rows[0] && Number(rows[0].totp_enabled) === 1);
}

async function loadUserByUsername(username) {
    const [rows] = await pool.query(
        'SELECT id, username, password_hash, role, volunteer_id, totp_enabled, totp_secret, totp_pending FROM users WHERE username=?',
        [username]
    );
    return rows[0] || null;
}

async function loadUserById(id) {
    const [rows] = await pool.query(
        'SELECT id, username, password_hash, role, volunteer_id, totp_enabled, totp_secret, totp_pending FROM users WHERE id=?',
        [id]
    );
    return rows[0] || null;
}

function setPending2fa(req, user) {
    req.session.pending_2fa = {
        id: user.id,
        username: user.username,
        role: user.role,
        volunteer_id: user.volunteer_id || null,
        exp: Date.now() + PENDING_2FA_MS
    };
}

function getPending2fa(req) {
    const p = req.session && req.session.pending_2fa;
    if (!p || !p.id || Date.now() > p.exp) {
        if (req.session) delete req.session.pending_2fa;
        return null;
    }
    return p;
}

function clearPending2fa(req) {
    if (req.session) delete req.session.pending_2fa;
}

function markReauthOk(req) {
    req.session.reauth_until = Date.now() + REAUTH_MS;
}

function hasFreshReauth(req) {
    return !!(req.session && req.session.reauth_until && Date.now() < req.session.reauth_until);
}

async function verifyReauth(req, body, verifyPasswordFn, opts) {
    if (!(opts && opts.force) && hasFreshReauth(req)) return { ok: true };
    const sess = req.session && (req.session.user || null);
    const uid = sess && sess.id;
    if (!uid) return { ok: false, error: '未登录' };
    const user = await loadUserById(uid);
    if (!user) return { ok: false, error: '账号不存在' };
    const password = body && (body.confirm_password || body.reauth_password);
    if (!(await verifyPasswordFn(password || '', user.password_hash))) {
        return { ok: false, error: '密码不正确' };
    }
    if (Number(user.totp_enabled) === 1) {
        const code = body && (body.confirm_totp || body.reauth_totp || body.totp);
        if (!totp.verifyTotp(user.totp_secret, code)) {
            return { ok: false, error: '动态验证码不正确' };
        }
    }
    markReauthOk(req);
    return { ok: true };
}

function isSensitiveAdminBody(body) {
    if (!body) return false;
    return body.delete_volunteer !== undefined
        || body.delete_id_card !== undefined
        || body.del_cert !== undefined
        || body.update_account !== undefined
        || body.create_account !== undefined
        || body.disable_2fa !== undefined;
}

function formatLogTime(d) {
    if (!d) return '';
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return String(d).slice(0, 19);
    const p = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate())
        + ' ' + p(x.getHours()) + ':' + p(x.getMinutes()) + ':' + p(x.getSeconds());
}

function auditDetailText(row) {
    const before = row.beforeJson;
    const after = row.afterJson;
    const detail = row.detail;
    const parts = {};
    if (before != null && (typeof before !== 'object' || Object.keys(before).length)) parts.before = before;
    if (after != null && (typeof after !== 'object' || Object.keys(after).length)) parts.after = after;
    if (detail != null && (typeof detail !== 'object' || Object.keys(detail).length)) parts.detail = detail;
    if (!Object.keys(parts).length) return '';
    try {
        return JSON.stringify(parts, null, 2).slice(0, 20000);
    } catch (_) {
        return '';
    }
}

function fmtChangeValue(v) {
    if (v == null) return '空';
    if (typeof v === 'object') return '已更新';
    const s = String(v).trim();
    if (!s) return '空';
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

function auditChangeText(row) {
    const before = row.beforeJson;
    const after = row.afterJson;
    if (before == null && after == null) return '';
    const catDefs = getCategoryDefs() || {};
    const parts = [];
    const cats = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const cat of cats) {
        const bCat = (before && before[cat]) || {};
        const aCat = (after && after[cat]) || {};
        if (typeof bCat !== 'object' || typeof aCat !== 'object') {
            if (String(bCat) !== String(aCat)) {
                const label = (catDefs[cat] && catDefs[cat].label) || cat;
                parts.push(label + ': ' + fmtChangeValue(bCat) + ' → ' + fmtChangeValue(aCat));
            }
            continue;
        }
        const keys = new Set([...Object.keys(bCat), ...Object.keys(aCat)]);
        for (const key of keys) {
            const b = bCat[key];
            const a = aCat[key];
            if (String(b) !== String(a)) {
                const label = (catDefs[cat] && catDefs[cat].fields && catDefs[cat].fields[key]
                    && catDefs[cat].fields[key].label) || key;
                parts.push(label + ': ' + fmtChangeValue(b) + ' → ' + fmtChangeValue(a));
            }
        }
    }
    return parts.join('；').slice(0, 2000);
}

const AUDIT_KINDS = {
    login: {
        label: '登录',
        table: 'auth_login_logs',
        retainKey: 'retain_auth_login_logs',
        search: ['username', 'ip', 'device', 'reason', 'source'],
        select: 'id, created_at, success, username AS actor, source AS extra, ip, user_agent, device, reason AS summary'
    },
    event: {
        label: '事件',
        table: 'rms_event_logs',
        retainKey: 'retain_rms_event_logs',
        search: ['actor_username', 'event_title', 'summary', 'action', 'ip'],
        select: 'id, created_at, actor_username AS actor, summary, CONCAT(IFNULL(action,\'\'), \' \', IFNULL(event_title,\'\')) AS extra, ip, detail, device, user_agent'
    },
    settings: {
        label: '系统设置',
        table: 'org_settings_logs',
        retainKey: 'retain_org_settings_logs',
        search: ['actor_username', 'summary', 'category', 'ip'],
        select: 'id, created_at, actor_username AS actor, summary, category AS extra, ip, detail, before_json AS beforeJson, after_json AS afterJson, device, user_agent'
    },
    profile: {
        label: '档案证件',
        table: 'org_profile_logs',
        retainKey: 'retain_org_profile_logs',
        search: ['actor_username', 'volunteer_name', 'summary', 'action', 'ip'],
        select: 'id, created_at, actor_username AS actor, summary, CONCAT(IFNULL(action,\'\'), \' \', IFNULL(volunteer_name,\'\')) AS extra, ip, detail, before_json AS beforeJson, after_json AS afterJson, device, user_agent'
    },
    message: {
        label: '调度消息',
        table: 'dispatch_message_logs',
        retainKey: 'retain_dispatch_message_logs',
        search: ['actor_username', 'recipient_username', 'message', 'kind'],
        select: 'id, created_at, actor_username AS actor, LEFT(message, 200) AS summary, CONCAT(IFNULL(kind,\'\'), \' \', IFNULL(recipient_username,\'\')) AS extra, ip, detail, device, user_agent'
    },
    status: {
        label: '人员状态',
        table: 'rms_status_logs',
        retainKey: 'retain_rms_status_logs',
        search: ['actor_username', 'target_username', 'summary', 'action', 'ip'],
        select: 'id, created_at, actor_username AS actor, summary, CONCAT(IFNULL(action,\'\'), \' \', IFNULL(target_username,\'\')) AS extra, ip, detail, device, user_agent'
    }
};

async function listAuditLogs(opts) {
    const kindKey = (opts && opts.kind && AUDIT_KINDS[opts.kind]) ? opts.kind : 'login';
    const def = AUDIT_KINDS[kindKey];
    const page = Math.max(1, parseInt(opts && opts.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(opts && opts.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;
    const where = [];
    const params = [];
    if (kindKey === 'login' && opts && opts.success === '1') where.push('success=1');
    if (kindKey === 'login' && opts && opts.success === '0') where.push('success=0');
    if (opts && opts.q) {
        const like = '%' + String(opts.q).trim().slice(0, 64) + '%';
        where.push('(' + def.search.map((col) => col + ' LIKE ?').join(' OR ') + ')');
        def.search.forEach(() => params.push(like));
    }
    const sqlWhere = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    try {
        const [countRows] = await pool.query(
            'SELECT COUNT(*) AS n FROM `' + def.table + '` ' + sqlWhere,
            params
        );
        const [rows] = await pool.query(
            'SELECT ' + def.select + ' FROM `' + def.table + '` ' + sqlWhere + ' ORDER BY id DESC LIMIT ? OFFSET ?',
            params.concat([pageSize, offset])
        );
        return {
            kind: kindKey,
            kinds: Object.keys(AUDIT_KINDS).map((k) => ({ id: k, label: AUDIT_KINDS[k].label })),
            rows: rows.map((row) => ({
                ...row,
                created_at: formatLogTime(row.created_at),
                changeText: auditChangeText(row)
            })),
            total: countRows[0] ? countRows[0].n : 0,
            page,
            pageSize,
            retentionDays: await retentionDaysFor(def.retainKey)
        };
    } catch (err) {
        console.warn('[authSecurity] list ' + def.table + ':', err.message);
        return {
            kind: kindKey,
            kinds: Object.keys(AUDIT_KINDS).map((k) => ({ id: k, label: AUDIT_KINDS[k].label })),
            rows: [],
            total: 0,
            page,
            pageSize,
            retentionDays: await retentionDaysFor(def.retainKey),
            error: err.message
        };
    }
}

async function listLoginLogs(opts) {
    return listAuditLogs({ ...(opts || {}), kind: 'login' });
}

async function beginLogin(req, username, source) {
    const gate = rateLimit.loginGate(req, username);
    if (!gate.ok) {
        await writeLoginLog(req, { success: false, username, reason: 'rate_limit', source });
        return { ok: false, status: 429, error: '尝试次数过多，请 ' + gate.retryAfter + ' 秒后再试。', retryAfter: gate.retryAfter };
    }
    const lock = await lockStatus(username);
    if (lock.locked) {
        await writeLoginLog(req, { success: false, username, reason: 'locked', source });
        const min = Math.ceil(lock.remainSec / 60);
        return { ok: false, status: 429, error: '登录已锁定，请 ' + min + ' 分钟后再试。', retryAfter: lock.remainSec };
    }
    return { ok: true };
}

async function failLogin(req, username, reason, source, userId) {
    rateLimit.loginFail(req, username);
    const after = await noteFail(username);
    await writeLoginLog(req, { success: false, username, userId, reason: reason || 'bad_credentials', source });
    if (after.locked) {
        const min = Math.ceil(after.remainSec / 60);
        return { locked: true, error: '连续失败过多，账号已锁定 ' + min + ' 分钟。' };
    }
    return { locked: false, error: '用户名或密码不正确。' };
}

async function succeedLogin(req, user, source) {
    rateLimit.loginOk(req, user.username);
    await noteOk(user.username);
    await writeLoginLog(req, {
        success: true,
        username: user.username,
        userId: user.id,
        reason: 'ok',
        source
    });
    try {
        await pool.query('UPDATE users SET last_login = NOW() WHERE id=?', [user.id]);
    } catch (_) { /* ignore */ }
}

module.exports = {
    FAIL_LIMIT,
    LOCK_MS,
    configure,
    ensureSchema,
    startPurgeLoop,
    purgeExpiredLogs,
    fingerprint,
    writeLoginLog,
    lockStatus,
    noteFail,
    noteOk,
    userHas2fa,
    loadUserByUsername,
    loadUserById,
    setPending2fa,
    getPending2fa,
    clearPending2fa,
    markReauthOk,
    hasFreshReauth,
    verifyReauth,
    isSensitiveAdminBody,
    listLoginLogs,
    listAuditLogs,
    beginLogin,
    failLogin,
    succeedLogin,
    totp,
    retentionDays,
    purgeExpiredLogs
};
