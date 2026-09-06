/**
 * RMS 分库日志：
 * - rms_status_logs   人员状态
 * - rms_event_logs    事件时间线
 * - dispatch_message_logs  单呼/广播/紧急（终端信息历史）
 * 旧表 dispatch_logs 不再写入，也不在启动时删除。
 */
const crypto = require('crypto');
const deviceInfo = require('../../_shared/deviceInfo');

const STATUS_LABEL = {
    1: '待命',
    2: '不可用',
    3: '响应中',
    4: '到达现场',
    5: '紧急报警',
    6: '离线'
};

let ensured = false;

function toDetail(detail) {
    if (detail == null) return null;
    if (typeof detail === 'string') return detail.slice(0, 8000);
    try {
        return JSON.stringify(detail).slice(0, 8000);
    } catch (_) {
        return String(detail).slice(0, 8000);
    }
}

async function ensureRmsLogTables(db) {
    if (!db || ensured) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS rms_status_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          action VARCHAR(64) NOT NULL,
          from_status TINYINT NULL,
          to_status TINYINT NULL,
          actor_user_id INT NULL,
          actor_username VARCHAR(64) NULL,
          target_user_id INT NOT NULL,
          target_username VARCHAR(64) NULL,
          event_id INT NULL,
          event_title VARCHAR(255) NULL,
          summary VARCHAR(500) NOT NULL,
          detail JSON NULL,
          ip VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_rsl_target_time (target_user_id, created_at),
          KEY idx_rsl_action_time (action, created_at),
          KEY idx_rsl_event (event_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS rms_event_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          action VARCHAR(64) NOT NULL,
          actor_user_id INT NULL,
          actor_username VARCHAR(64) NULL,
          target_user_id INT NULL,
          target_username VARCHAR(64) NULL,
          event_id INT NOT NULL,
          event_title VARCHAR(255) NULL,
          summary VARCHAR(500) NOT NULL,
          detail JSON NULL,
          ip VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_rel_event_time (event_id, created_at),
          KEY idx_rel_action_time (action, created_at),
          KEY idx_rel_target_time (target_user_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dispatch_message_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          kind ENUM('unicast','broadcast','emergency') NOT NULL,
          channel VARCHAR(16) NOT NULL DEFAULT 'terminal',
          batch_id CHAR(36) NULL,
          actor_user_id INT NULL,
          actor_username VARCHAR(64) NULL,
          recipient_user_id INT NOT NULL,
          recipient_username VARCHAR(64) NULL,
          recipient_display_name VARCHAR(128) NULL,
          scope VARCHAR(32) NULL,
          scope_label VARCHAR(255) NULL,
          message TEXT NOT NULL,
          detail JSON NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_dml_recipient_time (recipient_user_id, created_at),
          KEY idx_dml_kind_time (kind, created_at),
          KEY idx_dml_batch (batch_id),
          KEY idx_dml_actor_time (actor_user_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // 待接受指派
    for (const [table, cols] of [
        ['rms_status_logs', [['device', 'VARCHAR(255) NULL'], ['user_agent', 'VARCHAR(512) NULL']]],
        ['rms_event_logs', [['device', 'VARCHAR(255) NULL'], ['user_agent', 'VARCHAR(512) NULL']]],
        ['dispatch_message_logs', [['ip', 'VARCHAR(64) NULL'], ['device', 'VARCHAR(255) NULL'], ['user_agent', 'VARCHAR(512) NULL']]]
    ]) {
        for (const [col, def] of cols) {
            try {
                await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
            } catch (err) {
                if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
            }
        }
    }
    try {
        const [cols] = await db.query("SHOW COLUMNS FROM users LIKE 'pending_event_id'");
        if (!cols.length) {
            await db.query(
                "ALTER TABLE users ADD COLUMN pending_event_id INT NULL DEFAULT NULL COMMENT '调度指派待接受事件' AFTER current_event_id"
            );
        }
    } catch (err) {
        console.warn('[dispatchLog] pending_event_id:', err.message);
    }
    // 旧表 dispatch_logs 不再写入。禁止在启动时 DROP，以免清掉历史数据。
    ensured = true;
}

async function writeStatusLog(db, entry = {}) {
    if (!db) return;
    try {
        await db.query(
            `INSERT INTO rms_status_logs
             (action, from_status, to_status, actor_user_id, actor_username,
              target_user_id, target_username, event_id, event_title, summary, detail, ip, device, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
            [
                String(entry.action || 'change_status').slice(0, 64),
                entry.fromStatus != null ? Number(entry.fromStatus) : null,
                entry.toStatus != null ? Number(entry.toStatus) : null,
                entry.actorUserId != null ? entry.actorUserId : null,
                entry.actorUsername != null ? String(entry.actorUsername).slice(0, 64) : null,
                entry.targetUserId,
                entry.targetUsername != null ? String(entry.targetUsername).slice(0, 64) : null,
                entry.eventId != null ? entry.eventId : null,
                entry.eventTitle != null ? String(entry.eventTitle).slice(0, 255) : null,
                String(entry.summary || entry.action || '状态变更').slice(0, 500),
                toDetail(entry.detail),
                entry.ip != null ? String(entry.ip).slice(0, 64) : null,
                entry.device != null ? String(entry.device).slice(0, 255) : null,
                entry.userAgent != null ? String(entry.userAgent).slice(0, 512) : null
            ]
        );
    } catch (err) {
        console.error('[rms_status_logs]', err.message);
    }
}

async function writeEventLog(db, entry = {}) {
    if (!db || entry.eventId == null) return;
    try {
        await db.query(
            `INSERT INTO rms_event_logs
             (action, actor_user_id, actor_username, target_user_id, target_username,
              event_id, event_title, summary, detail, ip, device, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
            [
                String(entry.action || 'unknown').slice(0, 64),
                entry.actorUserId != null ? entry.actorUserId : null,
                entry.actorUsername != null ? String(entry.actorUsername).slice(0, 64) : null,
                entry.targetUserId != null ? entry.targetUserId : null,
                entry.targetUsername != null ? String(entry.targetUsername).slice(0, 64) : null,
                entry.eventId,
                entry.eventTitle != null ? String(entry.eventTitle).slice(0, 255) : null,
                String(entry.summary || entry.action || '事件操作').slice(0, 500),
                toDetail(entry.detail),
                entry.ip != null ? String(entry.ip).slice(0, 64) : null,
                entry.device != null ? String(entry.device).slice(0, 255) : null,
                entry.userAgent != null ? String(entry.userAgent).slice(0, 512) : null
            ]
        );
    } catch (err) {
        console.error('[rms_event_logs]', err.message);
    }
}

async function writeMessageLog(db, entry = {}) {
    if (!db || entry.recipientUserId == null) return null;
    try {
        const [result] = await db.query(
            `INSERT INTO dispatch_message_logs
             (kind, channel, batch_id, actor_user_id, actor_username,
              recipient_user_id, recipient_username, recipient_display_name,
              scope, scope_label, message, detail, ip, device, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
            [
                entry.kind || 'unicast',
                String(entry.channel || 'terminal').slice(0, 16),
                entry.batchId || null,
                entry.actorUserId != null ? entry.actorUserId : null,
                entry.actorUsername != null ? String(entry.actorUsername).slice(0, 64) : null,
                entry.recipientUserId,
                entry.recipientUsername != null ? String(entry.recipientUsername).slice(0, 64) : null,
                entry.recipientDisplayName != null ? String(entry.recipientDisplayName).slice(0, 128) : null,
                entry.scope != null ? String(entry.scope).slice(0, 32) : null,
                entry.scopeLabel != null ? String(entry.scopeLabel).slice(0, 255) : null,
                String(entry.message || ''),
                toDetail(entry.detail),
                entry.ip != null ? String(entry.ip).slice(0, 64) : null,
                entry.device != null ? String(entry.device).slice(0, 255) : null,
                entry.userAgent != null ? String(entry.userAgent).slice(0, 512) : null
            ]
        );
        return result.insertId || null;
    } catch (err) {
        console.error('[dispatch_message_logs]', err.message);
        return null;
    }
}

function newBatchId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
        (c ^ (crypto.randomBytes(1)[0] & (15 >> (c / 4)))).toString(16)
    );
}

function actorFromSocket(socket) {
    try {
        const req = socket && socket.request;
        const sess = req && req.session;
        if (!sess) return { actorUserId: null, actorUsername: null };
        const user = sess.user || (sess.user_id
            ? { id: sess.user_id, username: sess.username }
            : null);
        if (!user) return { actorUserId: null, actorUsername: null };
        const fp = deviceInfo.fromReq(req, true);
        return {
            actorUserId: user.id || null,
            actorUsername: user.username || null,
            ip: fp.ip,
            device: fp.device,
            userAgent: fp.userAgent
        };
    } catch (_) {
        return { actorUserId: null, actorUsername: null };
    }
}

function clientIp(req) {
    if (!req) return null;
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    if (xf) return String(xf).split(',')[0].trim();
    return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null;
}

function deviceFromReq(req) {
    if (!req) return { ip: null, device: null, userAgent: null };
    const fp = deviceInfo.fromReq(req, true);
    return { ip: fp.ip, device: fp.device, userAgent: fp.userAgent };
}

/** @deprecated 兼容旧调用名：默认写入事件日志（需带 eventId） */
async function writeDispatchLog(db, entry = {}) {
    if (entry.eventId != null) return writeEventLog(db, entry);
    // 无事件时尝试当状态日志（需 targetUserId）
    if (entry.targetUserId != null) {
        return writeStatusLog(db, {
            ...entry,
            toStatus: entry.detail && entry.detail.status != null ? entry.detail.status : null
        });
    }
}

module.exports = {
    ensureRmsLogTables,
    writeStatusLog,
    writeEventLog,
    writeMessageLog,
    writeDispatchLog,
    newBatchId,
    actorFromSocket,
    clientIp,
    deviceFromReq,
    STATUS_LABEL
};
