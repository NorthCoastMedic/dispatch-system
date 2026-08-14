const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { loadLocalEnv, envGet } = require('../_shared/env');
const { ensureUnifiedSession, setUnifiedSession, isAdminUser } = require('../_shared/session');
const authTokens = require('../_shared/authTokens');
const rateLimit = require('../_shared/rateLimit');
const {
    notifySafe,
    lookupPhoneByUserId,
    lookupPhonesByUserIds,
    buildEventDescription,
    parseEventLocationDetails,
    parseReportType,
    normalizeReportType,
    REPORT_TYPES,
    formatAssignMessage,
    formatUnassignMessage,
    formatEmergencyMessage,
    formatNewEventMessage,
    formatCompleteEventMessage,
    formatDispatchCallMessage
} = require('./lib/wecom');
const {
    ensureRmsLogTables,
    writeStatusLog,
    writeEventLog,
    writeMessageLog,
    newBatchId,
    actorFromSocket,
    clientIp,
    STATUS_LABEL
} = require('./lib/dispatchLog');
const { findDuplicateEvents, formatDuplicateHint, DEFAULT_WITHIN_MINUTES } = require('./lib/duplicateEvent');

const DISPATCH_CHANNELS = new Set(['terminal', 'wecom', 'all']);

async function notifyUser(db, userId, content) {
    const phone = await lookupPhoneByUserId(db, userId);
    if (!phone) {
        console.warn('[企业微信] 用户', userId, '未绑定志愿者手机号，消息将发送但不@人');
    }
    return notifySafe(content, __dirname, { mentionMobiles: phone ? [phone] : [] });
}

async function usernameById(db, userId) {
    if (!userId) return null;
    const [rows] = await db.query('SELECT username FROM users WHERE id = ? LIMIT 1', [userId]);
    return rows[0]?.username || null;
}

function normalizeDispatchChannel(raw) {
    const ch = String(raw || '').trim().toLowerCase();
    if (ch === 'both' || ch === '全部' || ch === '全部发送') return 'all';
    if (ch === '企业微信' || ch === 'wechat') return 'wecom';
    if (ch === '终端' || ch === 'terminal_only') return 'terminal';
    return DISPATCH_CHANNELS.has(ch) ? ch : '';
}

function previewMessage(text, max = 48) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

function emitDispatchMessageToUsers(io, userIds, payload) {
    if (!io) return { attempted: 0, connected: 0 };
    const ids = [...new Set((userIds || []).map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    let connected = 0;
    for (const id of ids) {
        const room = io.sockets.adapter.rooms.get('user:' + id);
        if (room && room.size > 0) connected += 1;
        io.to('user:' + id).emit('dispatch_message', payload);
    }
    return { attempted: ids.length, connected };
}

/** 查询广播对象：与调度人员列表一致（含 admin 账号），缺列时降级 */
async function queryBroadcastCandidates(db) {
    const attempts = [
        `SELECT u.id, u.username, u.role, u.status,
                IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name,
                IFNULL(v.agency, '') AS agency,
                IFNULL(v.phone, '') AS phone
         FROM users u
         LEFT JOIN volunteers v ON v.id = u.volunteer_id`,
        `SELECT u.id, u.username, u.role, u.status,
                IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name,
                '' AS agency,
                IFNULL(v.phone, '') AS phone
         FROM users u
         LEFT JOIN volunteers v ON v.id = u.volunteer_id`,
        `SELECT u.id, u.username, u.role, u.status,
                IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name,
                IFNULL(v.agency, '') AS agency,
                '' AS phone
         FROM users u
         LEFT JOIN volunteers v ON v.id = u.volunteer_id`,
        `SELECT u.id, u.username, u.role, u.status,
                u.username AS display_name,
                '' AS agency,
                '' AS phone
         FROM users u`
    ];
    let lastErr = null;
    for (const sql of attempts) {
        try {
            const [rows] = await db.query(sql);
            return rows || [];
        } catch (err) {
            lastErr = err;
            if (!(err && err.code === 'ER_BAD_FIELD_ERROR')) throw err;
        }
    }
    throw lastErr || new Error('无法读取广播人员');
}

/** 广播状态过滤：永远排除离线(6)；可选是否含不可用(2)。不排除发件人自己。 */
function filterBroadcastByStatus(list, options = {}) {
    const includeUnavailable = !!options.includeUnavailable;
    return (list || []).filter((u) => {
        const s = parseInt(u && u.status, 10);
        if (!Number.isFinite(s)) return false;
        if (s === 6) return false;
        if (!includeUnavailable && s === 2) return false;
        return true;
    });
}

/**
 * 解析广播对象
 * - userIds 有值：自选人员
 * - 否则按 agencies（含 __all__）
 * - 默认排除离线；includeUnavailable 控制是否含不可用
 */
async function listUsersForBroadcast(db, agencies, options = {}) {
    let list = await queryBroadcastCandidates(db);

    const rawIds = Array.isArray(options.userIds) ? options.userIds : [];
    const userIds = [...new Set(rawIds.map((id) => parseInt(id, 10)).filter((id) => id > 0))];

    if (userIds.length) {
        const idSet = new Set(userIds);
        const picked = list.filter((u) => idSet.has(Number(u.id)));
        const users = filterBroadcastByStatus(picked, options);
        return {
            all: false,
            mode: 'users',
            users,
            agencies: [],
            userIds: users.map((u) => Number(u.id))
        };
    }

    const wantAll = !agencies || !agencies.length
        || agencies.includes('__all__')
        || agencies.includes('全部');

    let scoped;
    let agencyLabels = ['全部'];
    if (wantAll) {
        scoped = list;
        agencyLabels = ['全部'];
    } else {
        const set = new Set(agencies.map((a) => String(a || '').trim()).filter(Boolean));
        const includeNone = set.has('__none__') || set.has('未分区');
        scoped = list.filter((u) => {
            const ag = String(u.agency || '').trim();
            if (!ag) return includeNone;
            return set.has(ag);
        });
        agencyLabels = [...set]
            .filter((a) => a !== '__none__' && a !== '未分区')
            .concat(includeNone ? ['未分区'] : []);
    }

    const users = filterBroadcastByStatus(scoped, options);
    return {
        all: !!wantAll,
        mode: wantAll ? 'all' : 'groups',
        users,
        agencies: agencyLabels,
        userIds: users.map((u) => Number(u.id))
    };
}

function createApp(options = {}) {
    const { io } = options;
    const local = loadLocalEnv(__dirname);
    const app = express();

    const db = mysql.createPool({
        host: envGet(local, 'DB_HOST', '127.0.0.1'),
        port: Number(envGet(local, 'DB_PORT', '3306')),
        user: envGet(local, 'DB_USER', 'root'),
        password: envGet(local, 'DB_PASSWORD', ''),
        database: envGet(local, 'DB_NAME', 'dispatch_db'),
        waitForConnections: true,
        connectionLimit: 10
    });

    ensureRmsLogTables(db).catch((err) => {
        console.error('[rms] 初始化日志表失败:', err.message);
    });

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    function authMiddleware(req, res, next) {
        const user = ensureUnifiedSession(req);
        if (!user) {
            return res.redirect('/login.php?redirect=' + encodeURIComponent('/rms' + (req.path || '/')));
        }
        req.session.user = user;
        next();
    }

    function adminMiddleware(req, res, next) {
        const user = ensureUnifiedSession(req);
        const wantsJson = String(req.path || '').startsWith('/api/')
            || String(req.headers.accept || '').includes('application/json');
        if (!user) {
            if (wantsJson) return res.status(401).json({ success: false, message: '未登录' });
            return res.redirect('/login.php?redirect=' + encodeURIComponent('/rms/dispatch.html'));
        }
        if (user.role !== 'admin') {
            if (wantsJson) return res.status(403).json({ success: false, message: '仅管理员可访问' });
            return res.status(403).send('拒绝访问：仅管理员/调度员可进入调度大屏');
        }
        next();
    }

    app.get('/report.html', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'report.html'));
    });

    app.get('/api/check-duplicate-event', async (req, res) => {
        const user = ensureUnifiedSession(req);
        if (!user) return res.status(401).json({ success: false, message: '未登录' });
        const title = String(req.query.title || '').trim();
        if (!title) return res.json({ success: true, duplicates: [] });
        try {
            const duplicates = await findDuplicateEvents(db, title);
            res.json({
                success: true,
                withinMinutes: DEFAULT_WITHIN_MINUTES,
                duplicates: duplicates.map((d) => ({
                    id: d.id,
                    title: d.title,
                    created_at: d.created_at
                }))
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: '查重失败' });
        }
    });

    app.post('/api/public-report', async (req, res) => {
        // title = 事件地点；联系方式 + 详细情况写入 description；report_type = 求助类型
        const title = String(req.body.title || req.body.location || '').trim();
        const contact = String(req.body.contact || '').trim();
        const details = String(req.body.details || '').trim();
        const reportType = normalizeReportType(req.body.report_type || req.body.reportType);
        const force = req.body.force === true || req.body.force === 1 || req.body.force === '1';

        if (!reportType) {
            return res.status(400).json({
                success: false,
                message: '请选择求助类型：' + REPORT_TYPES.join(' / ')
            });
        }
        if (!title || !contact || !details) {
            return res.status(400).json({ success: false, message: '请填写事件地点、联系方式和详细情况' });
        }
        if (title.length > 80 || contact.length > 80 || details.length > 1000) {
            return res.status(400).json({ success: false, message: '字段过长，请精简后重试' });
        }

        const lim = rateLimit.publicReport.hit('ip:' + rateLimit.clientIp(req));
        if (!lim.ok) {
            return res.status(429).json({
                success: false,
                message: '提交过于频繁，请 ' + lim.retryAfter + ' 秒后再试'
            });
        }

        const description = buildEventDescription(contact, details, reportType);

        try {
            if (!force) {
                const duplicates = await findDuplicateEvents(db, title);
                if (duplicates.length) {
                    return res.status(409).json({
                        success: false,
                        duplicate: true,
                        withinMinutes: DEFAULT_WITHIN_MINUTES,
                        message: formatDuplicateHint(duplicates),
                        duplicates: duplicates.map((d) => ({
                            id: d.id,
                            title: d.title,
                            created_at: d.created_at
                        }))
                    });
                }
            }

            const [result] = await db.query(
                'INSERT INTO events (title, description, priority, status) VALUES (?, ?, ?, "未完成")',
                [title, description, 3]
            );
            const eventId = result.insertId;
            const payload = {
                id: eventId,
                title,
                contact,
                details,
                description,
                report_type: reportType,
                created_at: new Date().toISOString()
            };

            if (io) {
                io.emit('public_report_alert', payload);
                await broadcastDataUpdate();
            }

            notifySafe(
                formatNewEventMessage(title, contact, details, reportType),
                __dirname,
                { mentionAll: true }
            );
            writeEventLog(db, {
                action: 'public_report',
                actorUsername: reportType,
                eventId,
                eventTitle: title,
                summary: force
                    ? `${reportType}（确认非重复）：${title}`
                    : `${reportType}：${title}`,
                detail: { contact, details, report_type: reportType, force: !!force },
                ip: clientIp(req)
            });

            return res.json({ success: true, id: eventId });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: '提交失败，请稍后重试' });
        }
    });

    app.get('/', authMiddleware, (req, res) => res.redirect('/rms/index.html'));
    app.get('/index.html', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
    app.get('/dispatch.html', adminMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dispatch.html')));
    app.get('/display.html', adminMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
    app.get('/login.html', (req, res) => {
        res.redirect('/login.php?redirect=' + encodeURIComponent('/rms/'));
    });

    app.use(express.static(path.join(__dirname, 'public')));

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        const gate = rateLimit.loginGate(req, username);
        if (!gate.ok) {
            return res.status(429).json({ success: false, message: '尝试次数过多，请稍后再试' });
        }
        try {
            const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
            if (users.length === 0) {
                rateLimit.loginFail(req, username);
                return res.status(401).json({ success: false, message: '账号或密码错误' });
            }

            const user = users[0];
            const hash = String(user.password_hash || '');
            if (!hash.startsWith('$2a$') && !hash.startsWith('$2b$') && !hash.startsWith('$2y$')) {
                rateLimit.loginFail(req, username);
                return res.status(401).json({ success: false, message: '账号密码需使用 bcrypt，请联系管理员重置' });
            }
            const passwordMatch = await bcrypt.compare(password, hash.replace(/^\$2y\$/, '$2b$'));
            if (!passwordMatch) {
                rateLimit.loginFail(req, username);
                return res.status(401).json({ success: false, message: '账号或密码错误' });
            }

            await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
            req.session.regenerate((err) => {
                if (err) return res.status(500).json({ success: false, message: '会话创建失败' });
                const sessionUser = {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    volunteer_id: user.volunteer_id
                };
                setUnifiedSession(req, sessionUser);
                const auth = authTokens.issueForUser(req, res, sessionUser, { includeTokens: true });
                rateLimit.loginOk(req, username);
                return res.json({ success: true, user: req.session.user, ...auth });
            });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: '服务器内部错误' });
        }
    });

    app.post('/api/logout', (req, res) => {
        authTokens.logoutTokens(req, res);
        req.session.destroy(() => res.json({ success: true }));
    });

    app.get('/api/me', (req, res) => {
        const user = ensureUnifiedSession(req);
        if (!user) return res.status(401).json({ success: false });
        res.json({ success: true, user, auth: authTokens.tokenMeta(req.auth, req.authRefresh) });
    });

    /** SLA 预告 / 超时写入事件时间线（rms_event_logs） */
    app.post('/api/sla-alert-log', adminMiddleware, async (req, res) => {
        try {
            const user = ensureUnifiedSession(req);
            const eventId = parseInt(req.body && req.body.eventId, 10);
            const stage = String((req.body && req.body.stage) || '').trim();
            if (!eventId || (stage !== 'warn' && stage !== 'timeout')) {
                return res.status(400).json({ success: false, message: '参数无效' });
            }

            const [events] = await db.query(
                'SELECT id, title, priority, description, status FROM events WHERE id = ? LIMIT 1',
                [eventId]
            );
            if (!events.length) {
                return res.status(404).json({ success: false, message: '事件不存在' });
            }
            const ev = events[0];
            const parsed = parseEventLocationDetails(ev.description || '');
            const reportType = parsed.report_type
                || normalizeReportType(req.body.report_type)
                || '其他问题求助';
            const priority = Number(req.body.priority) || Number(ev.priority) || 3;
            const priorityLabel = priority === 1 ? '高' : (priority === 2 ? '中' : '低');
            const isRepeat = !!(req.body && req.body.is_repeat);
            const elapsed = Number(req.body.elapsed_minutes);
            const warnMinutes = Number(req.body.warn_minutes);
            const timeoutMinutes = Number(req.body.timeout_minutes);
            const repeatMinutes = Number(req.body.repeat_minutes);

            const action = stage === 'warn' ? 'sla_warn' : 'sla_timeout';
            let summary;
            if (stage === 'warn') {
                summary = `SLA 预告：${ev.title || eventId}（${reportType}·${priorityLabel}）`;
            } else if (isRepeat) {
                summary = `SLA 再次超时提醒：${ev.title || eventId}（${reportType}·${priorityLabel}）`;
            } else {
                summary = `SLA 超时：${ev.title || eventId}（${reportType}·${priorityLabel}）`;
            }
            if (Number.isFinite(elapsed)) {
                summary += `，已等待约 ${Math.floor(elapsed)} 分钟`;
            }

            await writeEventLog(db, {
                action,
                actorUserId: user && user.id,
                actorUsername: (user && user.username) || '系统',
                eventId,
                eventTitle: ev.title || null,
                summary,
                detail: {
                    stage,
                    is_repeat: isRepeat,
                    report_type: reportType,
                    priority,
                    elapsed_minutes: Number.isFinite(elapsed) ? Math.floor(elapsed) : null,
                    warn_minutes: Number.isFinite(warnMinutes) ? warnMinutes : null,
                    timeout_minutes: Number.isFinite(timeoutMinutes) ? timeoutMinutes : null,
                    repeat_minutes: Number.isFinite(repeatMinutes) ? repeatMinutes : null
                },
                ip: clientIp(req)
            });

            return res.json({ success: true });
        } catch (err) {
            console.error('[sla-alert-log]', err);
            return res.status(500).json({ success: false, message: '写入日志失败' });
        }
    });

    app.get('/api/logs', adminMiddleware, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const kind = String(req.query.kind || 'event').trim();
        try {
            if (kind === 'status') {
                const [rows] = await db.query(
                    `SELECT id, action, from_status, to_status, actor_user_id, actor_username,
                            target_user_id, target_username, event_id, event_title, summary, detail, ip, created_at
                     FROM rms_status_logs ORDER BY id DESC LIMIT ?`,
                    [limit]
                );
                return res.json({ success: true, kind: 'status', logs: rows });
            }
            if (kind === 'message') {
                const [rows] = await db.query(
                    `SELECT id, kind, channel, batch_id, actor_user_id, actor_username,
                            recipient_user_id, recipient_username, recipient_display_name,
                            scope, scope_label, message, detail, created_at
                     FROM dispatch_message_logs ORDER BY id DESC LIMIT ?`,
                    [limit]
                );
                return res.json({ success: true, kind: 'message', logs: rows });
            }
            const [rows] = await db.query(
                `SELECT id, action, actor_user_id, actor_username, target_user_id, target_username,
                        event_id, event_title, summary, detail, ip, created_at
                 FROM rms_event_logs
                 ORDER BY id DESC
                 LIMIT ?`,
                [limit]
            );
            res.json({ success: true, kind: 'event', logs: rows });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: err.code === 'ER_NO_SUCH_TABLE'
                    ? '尚未创建日志表，请重启服务以自动建表'
                    : '读取日志失败'
            });
        }
    });

    /** 某人单呼历史（调度端） */
    app.get('/api/users/:id/unicast-history', adminMiddleware, async (req, res) => {
        const userId = parseInt(req.params.id, 10);
        if (!userId) return res.status(400).json({ success: false, message: '无效用户' });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
        try {
            const [rows] = await db.query(
                `SELECT id, kind, channel, actor_user_id, actor_username, message, detail, created_at
                 FROM dispatch_message_logs
                 WHERE recipient_user_id = ? AND kind = 'unicast'
                 ORDER BY id DESC
                 LIMIT ?`,
                [userId, limit]
            );
            res.json({ success: true, messages: rows });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: '读取单呼历史失败' });
        }
    });

    /** 终端：本人信息历史（单呼/广播/紧急） */
    app.get('/api/me/messages', async (req, res) => {
        const user = ensureUnifiedSession(req);
        if (!user) return res.status(401).json({ success: false, message: '未登录' });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
        try {
            const [rows] = await db.query(
                `SELECT id, kind, channel, actor_username, scope_label, message, created_at
                 FROM dispatch_message_logs
                 WHERE recipient_user_id = ?
                 ORDER BY id DESC
                 LIMIT ?`,
                [user.id, limit]
            );
            res.json({ success: true, messages: rows });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: '读取信息历史失败' });
        }
    });

    /** 调度端：广播历史（按 batch 聚合） */
    app.get('/api/broadcast-history', adminMiddleware, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 80, 1), 200);
        try {
            const [rows] = await db.query(
                `SELECT
                    COALESCE(batch_id, CONCAT('id-', id)) AS batch_key,
                    MIN(id) AS id,
                    MAX(actor_username) AS actor_username,
                    MAX(scope_label) AS scope_label,
                    MAX(channel) AS channel,
                    MAX(message) AS message,
                    COUNT(*) AS recipient_count,
                    MIN(created_at) AS created_at
                 FROM dispatch_message_logs
                 WHERE kind = 'broadcast'
                 GROUP BY COALESCE(batch_id, CONCAT('id-', id))
                 ORDER BY MIN(id) DESC
                 LIMIT ?`,
                [limit]
            );
            res.json({ success: true, messages: rows });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: '读取广播历史失败' });
        }
    });

    /** 单事件详情：基础信息 + 关联人员 + 时间线（rms_event_logs） */
    app.get('/api/events/:id', adminMiddleware, async (req, res) => {
        const eventId = parseInt(req.params.id, 10);
        if (!eventId) return res.status(400).json({ success: false, message: '无效事件 ID' });
        try {
            const [events] = await db.query('SELECT * FROM events WHERE id = ? LIMIT 1', [eventId]);
            if (!events.length) {
                return res.status(404).json({ success: false, message: '未找到该事件' });
            }
            const ev = events[0];
            const parsed = parseEventLocationDetails(ev.description || '');

            let source = '调度中心';
            if (parsed.report_type) {
                source = '外部上报';
            } else {
                try {
                    const [srcLogs] = await db.query(
                        `SELECT action FROM rms_event_logs
                         WHERE event_id = ? AND action IN ('public_report', 'add_event')
                         ORDER BY id ASC LIMIT 1`,
                        [eventId]
                    );
                    if (srcLogs[0]) {
                        source = srcLogs[0].action === 'public_report' ? '外部上报' : '系统建单';
                    }
                } catch (_) { /* 无日志表时忽略 */ }
            }

            let personnel = [];
            try {
                const responderId = ev.responder_id != null ? Number(ev.responder_id) : null;
                const [rows] = await db.query(
                    `SELECT u.id, u.username, u.status, u.current_event_id, u.pending_event_id,
                            v.name AS display_name
                     FROM users u
                     LEFT JOIN volunteers v ON v.id = u.volunteer_id
                     WHERE u.current_event_id = ?
                        OR u.pending_event_id = ?
                        OR (? IS NOT NULL AND u.id = ?)
                     ORDER BY u.id ASC`,
                    [eventId, eventId, responderId, responderId]
                );
                personnel = rows.map((p) => ({
                    id: Number(p.id),
                    username: p.username,
                    display_name: (p.display_name && String(p.display_name).trim()) || p.username,
                    status: Number(p.status),
                    pending: Number(p.pending_event_id) === Number(eventId),
                    is_primary_responder: responderId != null && Number(p.id) === responderId
                }));
            } catch (pErr) {
                console.warn('[event detail] personnel query fallback:', pErr.message);
                try {
                    const [rows] = await db.query(
                        `SELECT u.id, u.username, u.status
                         FROM users u
                         WHERE u.current_event_id = ?
                         ORDER BY u.id ASC`,
                        [eventId]
                    );
                    personnel = rows.map((p) => ({
                        id: Number(p.id),
                        username: p.username,
                        display_name: p.username,
                        status: Number(p.status),
                        pending: false,
                        is_primary_responder: false
                    }));
                } catch (_) {
                    personnel = [];
                }
            }

            let timeline = [];
            try {
                const [logs] = await db.query(
                    `SELECT id, action, actor_user_id, actor_username, target_user_id, target_username,
                            event_id, event_title, summary, detail, ip, created_at
                     FROM rms_event_logs
                     WHERE event_id = ?
                     ORDER BY id ASC`,
                    [eventId]
                );
                timeline = logs.map((l) => ({
                    id: Number(l.id),
                    action: l.action,
                    actor_user_id: l.actor_user_id != null ? Number(l.actor_user_id) : null,
                    actor_username: l.actor_username,
                    target_user_id: l.target_user_id != null ? Number(l.target_user_id) : null,
                    target_username: l.target_username,
                    event_id: l.event_id != null ? Number(l.event_id) : null,
                    event_title: l.event_title,
                    summary: l.summary,
                    detail: l.detail == null ? null : String(l.detail),
                    ip: l.ip,
                    created_at: l.created_at
                }));
            } catch (logErr) {
                if (logErr.code !== 'ER_NO_SUCH_TABLE') {
                    console.warn('[event detail] timeline:', logErr.message);
                }
            }

            const hasCreate = timeline.some((l) => l.action === 'add_event' || l.action === 'public_report');
            if (!hasCreate && ev.created_at) {
                timeline = [{
                    id: 0,
                    action: 'event_created',
                    actor_username: null,
                    target_username: null,
                    summary: '事件已创建（历史记录，无操作人日志）',
                    detail: null,
                    created_at: ev.created_at
                }, ...timeline];
            }

            const priorityLabel = Number(ev.priority) === 1 ? '高' : (Number(ev.priority) === 2 ? '中' : '低');

            return res.json({
                success: true,
                event: {
                    id: Number(ev.id),
                    title: ev.title,
                    description: ev.description,
                    priority: Number(ev.priority) || 3,
                    priority_label: priorityLabel,
                    status: ev.status,
                    responder_id: ev.responder_id != null ? Number(ev.responder_id) : null,
                    created_at: ev.created_at,
                    completed_at: ev.completed_at || null,
                    contact: parsed.contact,
                    details: parsed.details,
                    remark: parsed.remark || '',
                    report_type: parsed.report_type || '',
                    source
                },
                personnel,
                timeline
            });
        } catch (err) {
            console.error('[event detail]', err);
            return res.status(500).json({
                success: false,
                message: '读取事件详情失败：' + (err && err.message ? err.message : '未知错误')
            });
        }
    });

    /** 调度大屏：查看队员勾选「调度可见」的资质 */
    app.get('/api/personnel/:userId/certs', adminMiddleware, async (req, res) => {
        const userId = parseInt(req.params.userId, 10);
        if (!userId) return res.status(400).json({ success: false, message: '无效用户' });
        try {
            const [users] = await db.query(
                `SELECT u.id, u.username, u.volunteer_id, v.name AS display_name
                 FROM users u
                 LEFT JOIN volunteers v ON v.id = u.volunteer_id
                 WHERE u.id = ?
                 LIMIT 1`,
                [userId]
            );
            if (!users.length) {
                return res.status(404).json({ success: false, message: '未找到该人员' });
            }
            const u = users[0];
            const displayName = (u.display_name && String(u.display_name).trim()) || u.username || '未命名';
            if (!u.volunteer_id) {
                return res.json({ success: true, display_name: displayName, certs: [] });
            }

            const [internal] = await db.query(
                `SELECT id, cert_name, issue_date, image_url
                 FROM certs_internal
                 WHERE volunteer_id = ? AND show_on_dispatch = 1
                 ORDER BY issue_date DESC`,
                [u.volunteer_id]
            );
            const [external] = await db.query(
                `SELECT id, cert_name, issue_date, expiry_date, image_url
                 FROM certs_external
                 WHERE volunteer_id = ? AND show_on_dispatch = 1
                 ORDER BY expiry_date DESC`,
                [u.volunteer_id]
            );

            const certs = [
                ...internal.map((c) => ({
                    id: c.id,
                    type: 'internal',
                    label: '队内',
                    cert_name: c.cert_name,
                    issue_date: c.issue_date,
                    expiry_date: null,
                    image_url: c.image_url || null
                })),
                ...external.map((c) => ({
                    id: c.id,
                    type: 'external',
                    label: '通用',
                    cert_name: c.cert_name,
                    issue_date: c.issue_date,
                    expiry_date: c.expiry_date,
                    image_url: c.image_url || null
                }))
            ];

            res.json({ success: true, display_name: displayName, certs });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: err.code === 'ER_BAD_FIELD_ERROR'
                    ? '缺少 show_on_dispatch 字段，请先执行 ALTER TABLE'
                    : '读取资质失败'
            });
        }
    });

    async function broadcastDataUpdate() {
        if (!io) return;
        try {
            let users;
            try {
                [users] = await db.query(`
                    SELECT u.id, u.username, u.role, u.status, u.current_event_id, u.pending_event_id,
                           e.title AS event_title,
                           pe.title AS pending_event_title,
                           v.name AS display_name,
                           IFNULL(v.agency, '') AS agency
                    FROM users u
                    LEFT JOIN events e ON u.current_event_id = e.id
                    LEFT JOIN events pe ON u.pending_event_id = pe.id
                    LEFT JOIN volunteers v ON v.id = u.volunteer_id
                `);
            } catch (err) {
                if (err && err.code === 'ER_BAD_FIELD_ERROR') {
                    [users] = await db.query(`
                        SELECT u.id, u.username, u.role, u.status, u.current_event_id,
                               e.title AS event_title,
                               v.name AS display_name
                        FROM users u
                        LEFT JOIN events e ON u.current_event_id = e.id
                        LEFT JOIN volunteers v ON v.id = u.volunteer_id
                    `);
                    users = users.map((u) => ({
                        ...u,
                        agency: '',
                        pending_event_id: null,
                        pending_event_title: null
                    }));
                } else {
                    throw err;
                }
            }
            const [events] = await db.query('SELECT * FROM events ORDER BY priority ASC, created_at DESC');
            io.emit('data_updated', { users, events });
        } catch (err) {
            console.error('广播更新失败:', err);
        }
    }

    if (io) {
        io.on('connection', (socket) => {
            const sessionUser = ensureUnifiedSession(socket.request);
            if (!sessionUser) {
                socket.emit('auth_error', { message: '未登录' });
                socket.disconnect(true);
                return;
            }
            socket.data.user = sessionUser;
            if (sessionUser.id) {
                socket.join('user:' + sessionUser.id);
            }
            broadcastDataUpdate();

            function currentUser() {
                return ensureUnifiedSession(socket.request) || socket.data.user;
            }

            function requireLogin() {
                const user = currentUser();
                return user || null;
            }

            function requireAdmin() {
                const user = requireLogin();
                return user && isAdminUser(user) ? user : null;
            }

            /** 本人或管理员 */
            function canActOnUser(targetUserId) {
                const user = requireLogin();
                if (!user) return null;
                if (isAdminUser(user)) return user;
                if (Number(user.id) === Number(targetUserId)) return user;
                return null;
            }

            socket.on('change_status', async (data) => {
                const { userId, status } = data;
                let eventId = data.eventId != null ? parseInt(data.eventId, 10) : null;
                if (eventId && Number.isNaN(eventId)) eventId = null;
                if (!canActOnUser(userId)) return;
                try {
                    const [cur] = await db.query(
                        'SELECT status, current_event_id, pending_event_id FROM users WHERE id = ?',
                        [userId]
                    );
                    if (cur[0] && Number(cur[0].status) === 5 && Number(status) !== 5) {
                        return;
                    }
                    const fromStatus = cur[0] ? Number(cur[0].status) : null;
                    const boundEventId = cur[0] && cur[0].current_event_id
                        ? Number(cur[0].current_event_id)
                        : null;
                    const logEventId = eventId || boundEventId || null;

                    if (eventId) {
                        await db.query(
                            'UPDATE users SET status = ?, current_event_id = ?, pending_event_id = NULL WHERE id = ?',
                            [status, eventId, userId]
                        );
                        await db.query(
                            'UPDATE events SET responder_id = ? WHERE id = ?',
                            [userId, eventId]
                        );
                    } else {
                        await db.query('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
                    }
                    await broadcastDataUpdate();

                    let eventTitle = null;
                    if (logEventId) {
                        const [events] = await db.query('SELECT title FROM events WHERE id = ?', [logEventId]);
                        eventTitle = events[0]?.title || null;
                    }

                    const actor = actorFromSocket(socket);
                    const uname = await usernameById(db, userId);
                    const statusNum = Number(status);
                    const statusName = STATUS_LABEL[statusNum] || String(status);
                    const summary = statusNum === 4
                        ? `${uname || userId} 到达现场${eventTitle ? '「' + eventTitle + '」' : ''}`
                        : `${uname || userId} 状态改为 ${statusName}${eventTitle ? '（事件：' + eventTitle + '）' : ''}`;

                    writeStatusLog(db, {
                        ...actor,
                        action: statusNum === 4 ? 'arrive_scene' : 'change_status',
                        fromStatus,
                        toStatus: statusNum,
                        targetUserId: userId,
                        targetUsername: uname,
                        eventId: logEventId,
                        eventTitle,
                        summary,
                        detail: { status: statusNum, eventId: logEventId }
                    });
                    if (statusNum === 4 && logEventId) {
                        writeEventLog(db, {
                            ...actor,
                            action: 'arrive_scene',
                            targetUserId: userId,
                            targetUsername: uname,
                            eventId: logEventId,
                            eventTitle,
                            summary,
                            detail: { status: 4 }
                        });
                    }
                } catch (err) { console.error(err); }
            });

            socket.on('stop_responding', async (data) => {
                const { userId } = data;
                if (!canActOnUser(userId)) return;
                try {
                    const [users] = await db.query(
                        'SELECT username, status, current_event_id FROM users WHERE id = ?',
                        [userId]
                    );
                    const eventId = users[0]?.current_event_id;
                    const fromStatus = users[0] != null ? Number(users[0].status) : null;
                    const uname = users[0]?.username || null;
                    let eventTitle = null;
                    if (eventId) {
                        const [events] = await db.query('SELECT title FROM events WHERE id = ?', [eventId]);
                        eventTitle = events[0]?.title || null;
                    }
                    await db.query(
                        'UPDATE users SET status = 1, current_event_id = NULL WHERE id = ?',
                        [userId]
                    );
                    if (eventId) {
                        await db.query(
                            'UPDATE events SET responder_id = NULL WHERE id = ? AND responder_id = ?',
                            [eventId, userId]
                        );
                    }
                    await broadcastDataUpdate();
                    const actor = actorFromSocket(socket);
                    const summary = `${uname || userId} 停止响应事件${eventTitle ? '「' + eventTitle + '」' : ''}`;
                    writeStatusLog(db, {
                        ...actor,
                        action: 'stop_responding',
                        fromStatus,
                        toStatus: 1,
                        targetUserId: userId,
                        targetUsername: uname,
                        eventId: eventId || null,
                        eventTitle,
                        summary
                    });
                    if (eventId) {
                        writeEventLog(db, {
                            ...actor,
                            action: 'stop_responding',
                            targetUserId: userId,
                            targetUsername: uname,
                            eventId,
                            eventTitle,
                            summary
                        });
                    }
                } catch (err) { console.error(err); }
            });

            socket.on('add_event', async (data, ack) => {
                if (!requireAdmin()) {
                    if (typeof ack === 'function') ack({ success: false, message: '需要管理员权限' });
                    return;
                }
                const title = String(data.title || '').trim();
                const contact = String(data.contact || '').trim();
                const details = String(data.details || '').trim();
                const priority = parseInt(data.priority, 10) || 3;
                const force = data.force === true || data.force === 1 || data.force === '1';
                const reportType = normalizeReportType(data.report_type || data.reportType) || '';
                // 兼容旧客户端：直接传 description；有联系/详情时写入【类型】前缀供 SLA 识别
                const description = (contact || details)
                    ? buildEventDescription(contact, details, reportType || null)
                    : String(data.description || '').trim();
                if (!title || !description) {
                    if (typeof ack === 'function') ack({ success: false, message: '请填写完整信息' });
                    return;
                }
                if (contact || details) {
                    if (!reportType) {
                        if (typeof ack === 'function') ack({ success: false, message: '请选择求助类型' });
                        return;
                    }
                }
                try {
                    if (!force) {
                        const duplicates = await findDuplicateEvents(db, title);
                        if (duplicates.length) {
                            const payload = {
                                success: false,
                                duplicate: true,
                                withinMinutes: DEFAULT_WITHIN_MINUTES,
                                message: formatDuplicateHint(duplicates),
                                duplicates: duplicates.map((d) => ({
                                    id: d.id,
                                    title: d.title,
                                    created_at: d.created_at
                                }))
                            };
                            if (typeof ack === 'function') ack(payload);
                            else socket.emit('add_event_duplicate', payload);
                            return;
                        }
                    }

                    const [result] = await db.query(
                        'INSERT INTO events (title, description, priority, status) VALUES (?, ?, ?, "未完成")',
                        [title, description, priority]
                    );
                    const eventId = result.insertId;
                    await broadcastDataUpdate();
                    const parsed = (contact || details)
                        ? { contact: contact || '未填写', details: details || '无', report_type: reportType }
                        : parseEventLocationDetails(description);
                    notifySafe(
                        formatNewEventMessage(title, parsed.contact, parsed.details, reportType || parsed.report_type || ''),
                        __dirname,
                        { mentionAll: true }
                    );
                    writeEventLog(db, {
                        ...actorFromSocket(socket),
                        action: 'add_event',
                        eventId,
                        eventTitle: title,
                        summary: reportType
                            ? `调度发布新事件：${title}（${reportType}）`
                            : `调度发布新事件：${title}`,
                        detail: {
                            contact: parsed.contact,
                            details: parsed.details,
                            priority,
                            report_type: reportType || parsed.report_type || '',
                            force: !!force
                        }
                    });
                    if (typeof ack === 'function') ack({ success: true, id: eventId });
                } catch (err) {
                    console.error(err);
                    if (typeof ack === 'function') ack({ success: false, message: '发布失败' });
                }
            });

            socket.on('update_event', async (data) => {
                if (!requireAdmin()) return;
                const eventId = parseInt(data.eventId, 10);
                const title = String(data.title || '').trim();
                const contact = String(data.contact || '').trim();
                const details = String(data.details || '').trim();
                const remark = String(data.remark || '').trim();
                const priority = parseInt(data.priority, 10) || 3;
                if (!eventId || !title || !contact || !details) return;
                try {
                    const [rows] = await db.query('SELECT description FROM events WHERE id = ? AND status = "未完成"', [eventId]);
                    if (!rows.length) {
                        console.warn('[update_event] 未更新：事件不存在或已完成', eventId);
                        return;
                    }
                    const keptType = parseReportType(rows[0].description || '');
                    const finalDesc = buildEventDescription(contact, details, keptType || null, remark);
                    await db.query(
                        'UPDATE events SET title = ?, description = ?, priority = ? WHERE id = ? AND status = "未完成"',
                        [title, finalDesc, priority, eventId]
                    );
                    await broadcastDataUpdate();
                    writeEventLog(db, {
                        ...actorFromSocket(socket),
                        action: 'update_event',
                        eventId,
                        eventTitle: title,
                        summary: `修改进行中事件：${title}`,
                        detail: { contact, details, remark, priority }
                    });
                } catch (err) { console.error('修改事件失败:', err); }
            });

            socket.on('complete_event', async (data) => {
                if (!requireAdmin()) return;
                const { eventId } = data;
                try {
                    const [events] = await db.query('SELECT title, description FROM events WHERE id = ?', [eventId]);
                    await db.query('UPDATE events SET status = "已完成", completed_at = NOW() WHERE id = ?', [eventId]);
                    await db.query(
                        'UPDATE users SET status = 1, current_event_id = NULL WHERE current_event_id = ?',
                        [eventId]
                    );
                    try {
                        await db.query(
                            'UPDATE users SET pending_event_id = NULL WHERE pending_event_id = ?',
                            [eventId]
                        );
                    } catch (_) { /* 无 pending 列时忽略 */ }
                    await broadcastDataUpdate();
                    if (events[0]) {
                        const title = events[0].title || '未填写地点';
                        const { contact, details } = parseEventLocationDetails(events[0].description);
                        notifySafe(
                            formatCompleteEventMessage(title, contact, details),
                            __dirname,
                            { mentionAll: true }
                        );
                        writeEventLog(db, {
                            ...actorFromSocket(socket),
                            action: 'complete_event',
                            eventId,
                            eventTitle: title,
                            summary: `标记事件完成：${title}`,
                            detail: { contact, details }
                        });
                    }
                } catch (err) { console.error(err); }
            });

            socket.on('reopen_event', async (data) => {
                if (!requireAdmin()) return;
                const { eventId } = data;
                try {
                    const [events] = await db.query('SELECT title FROM events WHERE id = ?', [eventId]);
                    await db.query('UPDATE events SET status = "未完成", completed_at = NULL WHERE id = ?', [eventId]);
                    await broadcastDataUpdate();
                    writeEventLog(db, {
                        ...actorFromSocket(socket),
                        action: 'reopen_event',
                        eventId,
                        eventTitle: events[0]?.title || null,
                        summary: `重新打开事件：${events[0]?.title || eventId}`
                    });
                } catch (err) { console.error(err); }
            });

            socket.on('trigger_emergency', async (data) => {
                const { userId } = data;
                if (!canActOnUser(userId)) return;
                try {
                    const [cur] = await db.query('SELECT status, username FROM users WHERE id = ?', [userId]);
                    const fromStatus = cur[0] != null ? Number(cur[0].status) : null;
                    await db.query('UPDATE users SET status = 5 WHERE id = ?', [userId]);
                    const username = cur[0]?.username || '未知人员';
                    io.emit('emergency_alert_broadcast', { userId, username });
                    await broadcastDataUpdate();
                    notifySafe(formatEmergencyMessage(username), __dirname, { mentionAll: true });
                    const actor = actorFromSocket(socket);
                    const summary = `${username} 激活紧急报警`;
                    writeStatusLog(db, {
                        ...actor,
                        action: 'trigger_emergency',
                        fromStatus,
                        toStatus: 5,
                        targetUserId: userId,
                        targetUsername: username,
                        summary
                    });
                    // 写入相关人员信息历史
                    const batchId = newBatchId();
                    const msg = formatEmergencyMessage(username);
                    try {
                        const [recipients] = await db.query(
                            `SELECT u.id, u.username, IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name
                             FROM users u LEFT JOIN volunteers v ON v.id = u.volunteer_id
                             WHERE u.status IS NULL OR u.status <> 6`
                        );
                        for (const r of recipients || []) {
                            writeMessageLog(db, {
                                kind: 'emergency',
                                channel: 'terminal',
                                batchId,
                                actorUserId: actor.actorUserId,
                                actorUsername: username,
                                recipientUserId: r.id,
                                recipientUsername: r.username,
                                recipientDisplayName: r.display_name,
                                message: msg,
                                detail: { source_user_id: userId }
                            });
                            if (io && Number(r.id) !== Number(userId)) {
                                io.to('user:' + r.id).emit('dispatch_message', {
                                    id: `e-${batchId}-${r.id}`,
                                    kind: 'emergency',
                                    message: msg,
                                    preview: msg,
                                    from: username,
                                    created_at: new Date().toISOString()
                                });
                            }
                        }
                    } catch (mErr) {
                        console.warn('[emergency message log]', mErr.message);
                    }
                } catch (err) { console.error(err); }
            });

            socket.on('cancel_emergency', async (data) => {
                const { userId } = data;
                if (!canActOnUser(userId)) return;
                try {
                    const uname = await usernameById(db, userId);
                    await db.query('UPDATE users SET status = 1 WHERE id = ? AND status = 5', [userId]);
                    await broadcastDataUpdate();
                    writeStatusLog(db, {
                        ...actorFromSocket(socket),
                        action: 'cancel_emergency',
                        fromStatus: 5,
                        toStatus: 1,
                        targetUserId: userId,
                        targetUsername: uname,
                        summary: `${uname || userId} 取消紧急报警`
                    });
                } catch (err) { console.error('取消紧急报警失败:', err); }
            });

            /** 调度指派：仅挂起待接受，不直接进入响应中 */
            socket.on('assign_event', async ({ userId, eventId }) => {
                if (!requireAdmin()) return;
                try {
                    const [events] = await db.query(
                        'SELECT id, title, description, status FROM events WHERE id = ? LIMIT 1',
                        [eventId]
                    );
                    if (!events.length || events[0].status !== '未完成') return;
                    const [users] = await db.query(
                        `SELECT u.id, u.username, IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name
                         FROM users u LEFT JOIN volunteers v ON v.id = u.volunteer_id
                         WHERE u.id = ? LIMIT 1`,
                        [userId]
                    );
                    if (!users.length) return;
                    const username = users[0].username || '未知人员';
                    const displayName = users[0].display_name || username;
                    const title = events[0].title || '未填写地点';
                    const { contact, details } = parseEventLocationDetails(events[0].description);

                    await db.query(
                        'UPDATE users SET pending_event_id = ? WHERE id = ?',
                        [eventId, userId]
                    );

                    notifyUser(db, userId, formatAssignMessage(displayName, title, contact, details));
                    if (io) {
                        io.to('user:' + userId).emit('assign_offer', {
                            eventId,
                            title,
                            contact,
                            details
                        });
                    }
                    await broadcastDataUpdate();
                    writeEventLog(db, {
                        ...actorFromSocket(socket),
                        action: 'assign_event',
                        targetUserId: userId,
                        targetUsername: displayName,
                        eventId,
                        eventTitle: title,
                        summary: `指派待确认 ${displayName} → ${title}`,
                        detail: { contact, details, pending: true }
                    });
                } catch (err) { console.error('指派事件失败:', err); }
            });

            socket.on('batch_assign_event', async (data, ack) => {
                if (!requireAdmin()) {
                    if (typeof ack === 'function') ack({ success: false, message: '需要管理员权限' });
                    return;
                }
                const eventId = parseInt(data && data.eventId, 10);
                const rawIds = Array.isArray(data && data.userIds) ? data.userIds : [];
                const userIds = [...new Set(rawIds.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
                if (!eventId || !userIds.length) {
                    if (typeof ack === 'function') ack({ success: false, message: '请选择事件与人员' });
                    return;
                }
                try {
                    const [events] = await db.query(
                        'SELECT id, title, description, status FROM events WHERE id = ? LIMIT 1',
                        [eventId]
                    );
                    if (!events.length || events[0].status !== '未完成') {
                        if (typeof ack === 'function') ack({ success: false, message: '事件不存在或已完成' });
                        return;
                    }
                    const title = events[0].title || '未填写地点';
                    const { contact, details } = parseEventLocationDetails(events[0].description);
                    const actor = actorFromSocket(socket);

                    let assigned = 0;
                    let skipped = 0;
                    const assignedNames = [];

                    for (const userId of userIds) {
                        const [users] = await db.query(
                            `SELECT u.id, u.username, u.current_event_id, u.pending_event_id, u.status,
                                    IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name
                             FROM users u LEFT JOIN volunteers v ON v.id = u.volunteer_id
                             WHERE u.id = ? LIMIT 1`,
                            [userId]
                        );
                        if (!users.length) continue;
                        const u = users[0];
                        if (Number(u.status) === 6) {
                            skipped += 1;
                            continue;
                        }
                        if (Number(u.current_event_id) === Number(eventId)
                            || Number(u.pending_event_id) === Number(eventId)) {
                            skipped += 1;
                            continue;
                        }

                        await db.query('UPDATE users SET pending_event_id = ? WHERE id = ?', [eventId, userId]);
                        const displayName = u.display_name || u.username || '未知人员';
                        assignedNames.push(displayName);
                        assigned += 1;
                        notifyUser(db, userId, formatAssignMessage(displayName, title, contact, details));
                        if (io) {
                            io.to('user:' + userId).emit('assign_offer', {
                                eventId,
                                title,
                                contact,
                                details
                            });
                        }
                        writeEventLog(db, {
                            ...actor,
                            action: 'assign_event',
                            targetUserId: userId,
                            targetUsername: displayName,
                            eventId,
                            eventTitle: title,
                            summary: `指派待确认 ${displayName} → ${title}`,
                            detail: { contact, details, batch: true, pending: true }
                        });
                    }

                    if (assigned > 0) {
                        writeEventLog(db, {
                            ...actor,
                            action: 'batch_assign_event',
                            eventId,
                            eventTitle: title,
                            summary: `批量指派待确认 ${assigned} 人 → ${title}：${assignedNames.join('、')}`,
                            detail: {
                                user_ids: userIds,
                                assigned_names: assignedNames,
                                assigned,
                                skipped,
                                contact,
                                details,
                                pending: true
                            }
                        });
                    }

                    await broadcastDataUpdate();
                    if (typeof ack === 'function') {
                        ack({ success: true, assigned, skipped, names: assignedNames });
                    }
                } catch (err) {
                    console.error('批量指派失败:', err);
                    if (typeof ack === 'function') ack({ success: false, message: '批量指派失败' });
                }
            });

            socket.on('accept_assign', async (data, ack) => {
                const userId = parseInt(data && data.userId, 10);
                if (!canActOnUser(userId)) {
                    if (typeof ack === 'function') ack({ success: false, message: '无权限' });
                    return;
                }
                try {
                    const [users] = await db.query(
                        `SELECT u.id, u.username, u.pending_event_id, u.status,
                                IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name
                         FROM users u LEFT JOIN volunteers v ON v.id = u.volunteer_id
                         WHERE u.id = ? LIMIT 1`,
                        [userId]
                    );
                    if (!users.length || !users[0].pending_event_id) {
                        if (typeof ack === 'function') ack({ success: false, message: '没有待确认的指派' });
                        return;
                    }
                    const eventId = Number(users[0].pending_event_id);
                    const [events] = await db.query(
                        'SELECT id, title, status FROM events WHERE id = ? LIMIT 1',
                        [eventId]
                    );
                    if (!events.length || events[0].status !== '未完成') {
                        await db.query('UPDATE users SET pending_event_id = NULL WHERE id = ?', [userId]);
                        await broadcastDataUpdate();
                        if (typeof ack === 'function') ack({ success: false, message: '事件已不存在或已完成' });
                        return;
                    }
                    const fromStatus = Number(users[0].status);
                    const displayName = users[0].display_name || users[0].username;
                    const title = events[0].title || '未填写地点';
                    await db.query(
                        'UPDATE users SET status = 3, current_event_id = ?, pending_event_id = NULL WHERE id = ?',
                        [eventId, userId]
                    );
                    await db.query('UPDATE events SET responder_id = ? WHERE id = ?', [userId, eventId]);
                    await broadcastDataUpdate();
                    const actor = actorFromSocket(socket);
                    const summary = `${displayName} 接受指派 → ${title}`;
                    writeEventLog(db, {
                        ...actor,
                        action: 'accept_assign',
                        targetUserId: userId,
                        targetUsername: displayName,
                        eventId,
                        eventTitle: title,
                        summary
                    });
                    writeStatusLog(db, {
                        ...actor,
                        action: 'accept_assign',
                        fromStatus,
                        toStatus: 3,
                        targetUserId: userId,
                        targetUsername: displayName,
                        eventId,
                        eventTitle: title,
                        summary
                    });
                    if (typeof ack === 'function') ack({ success: true });
                } catch (err) {
                    console.error('接受指派失败:', err);
                    if (typeof ack === 'function') ack({ success: false, message: '接受失败' });
                }
            });

            socket.on('reject_assign', async (data, ack) => {
                const userId = parseInt(data && data.userId, 10);
                if (!canActOnUser(userId)) {
                    if (typeof ack === 'function') ack({ success: false, message: '无权限' });
                    return;
                }
                try {
                    const [users] = await db.query(
                        `SELECT u.id, u.username, u.pending_event_id,
                                IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name
                         FROM users u LEFT JOIN volunteers v ON v.id = u.volunteer_id
                         WHERE u.id = ? LIMIT 1`,
                        [userId]
                    );
                    if (!users.length || !users[0].pending_event_id) {
                        if (typeof ack === 'function') ack({ success: false, message: '没有待确认的指派' });
                        return;
                    }
                    const eventId = Number(users[0].pending_event_id);
                    const displayName = users[0].display_name || users[0].username;
                    let title = null;
                    const [events] = await db.query('SELECT title FROM events WHERE id = ? LIMIT 1', [eventId]);
                    title = events[0]?.title || null;
                    await db.query('UPDATE users SET pending_event_id = NULL WHERE id = ?', [userId]);
                    await broadcastDataUpdate();
                    writeEventLog(db, {
                        ...actorFromSocket(socket),
                        action: 'reject_assign',
                        targetUserId: userId,
                        targetUsername: displayName,
                        eventId,
                        eventTitle: title,
                        summary: `${displayName} 拒绝指派${title ? ' ← ' + title : ''}`
                    });
                    if (typeof ack === 'function') ack({ success: true });
                } catch (err) {
                    console.error('拒绝指派失败:', err);
                    if (typeof ack === 'function') ack({ success: false, message: '拒绝失败' });
                }
            });

            socket.on('unassign_event', async ({ userId }) => {
                if (!requireAdmin()) return;
                try {
                    const [users] = await db.query(
                        'SELECT username, current_event_id, pending_event_id FROM users WHERE id = ?',
                        [userId]
                    );
                    const eventId = users[0]?.current_event_id || users[0]?.pending_event_id;
                    const wasPendingOnly = !users[0]?.current_event_id && !!users[0]?.pending_event_id;
                    const username = users[0]?.username || '未知人员';

                    let title = '未填写地点';
                    let contact = '未填写';
                    let details = '无';
                    if (eventId) {
                        const [events] = await db.query('SELECT title, description FROM events WHERE id = ?', [eventId]);
                        if (events[0]) {
                            title = events[0].title || title;
                            ({ contact, details } = parseEventLocationDetails(events[0].description));
                        }
                    }

                    await db.query(
                        'UPDATE users SET status = 1, current_event_id = NULL, pending_event_id = NULL WHERE id = ?',
                        [userId]
                    );
                    if (users[0]?.current_event_id) {
                        await db.query(
                            'UPDATE events SET responder_id = NULL WHERE id = ? AND responder_id = ?',
                            [users[0].current_event_id, userId]
                        );
                    }
                    await broadcastDataUpdate();

                    if (eventId) {
                        if (!wasPendingOnly) {
                            notifyUser(db, userId, formatUnassignMessage(username, title, contact, details));
                        }
                        writeEventLog(db, {
                            ...actorFromSocket(socket),
                            action: 'unassign_event',
                            targetUserId: userId,
                            targetUsername: username,
                            eventId,
                            eventTitle: title,
                            summary: wasPendingOnly
                                ? `撤销待确认指派 ${username} ← ${title}`
                                : `取消指派 ${username} ← ${title}`,
                            detail: { contact, details, pending_only: wasPendingOnly }
                        });
                    }
                } catch (err) { console.error('取消指派失败:', err); }
            });

            /** 单呼：可选终端 / 企业微信 / 全部 */
            socket.on('unicast_message', async (data, ack) => {
                if (!requireAdmin()) {
                    if (typeof ack === 'function') ack({ success: false, message: '需要管理员权限' });
                    return;
                }
                const userId = parseInt(data && data.userId, 10);
                const message = String((data && data.message) || '').trim();
                const channel = normalizeDispatchChannel(data && data.channel);
                if (!userId) {
                    if (typeof ack === 'function') ack({ success: false, message: '请选择队员' });
                    return;
                }
                if (!message) {
                    if (typeof ack === 'function') ack({ success: false, message: '请填写通知内容' });
                    return;
                }
                if (message.length > 1000) {
                    if (typeof ack === 'function') ack({ success: false, message: '内容过长（最多 1000 字）' });
                    return;
                }
                if (!channel) {
                    if (typeof ack === 'function') ack({ success: false, message: '请选择发送渠道' });
                    return;
                }
                try {
                    const profiles = await lookupPhonesByUserIds(db, [userId]);
                    const profile = profiles[0];
                    if (!profile) {
                        if (typeof ack === 'function') ack({ success: false, message: '队员不存在' });
                        return;
                    }
                    const actor = actorFromSocket(socket);
                    const fromName = actor.actorUsername || '调度员';
                    const targetName = profile.displayName;
                    const payload = {
                        id: `u-${Date.now()}-${userId}`,
                        kind: 'unicast',
                        message,
                        preview: previewMessage(message),
                        from: fromName,
                        target_user_id: userId,
                        created_at: new Date().toISOString()
                    };

                    let terminalSent = 0;
                    let terminalConnected = 0;
                    let wecomResult = null;
                    if (channel === 'terminal' || channel === 'all') {
                        const sent = emitDispatchMessageToUsers(io, [userId], payload);
                        terminalSent = sent.attempted;
                        terminalConnected = sent.connected;
                    }
                    if (channel === 'wecom' || channel === 'all') {
                        wecomResult = await notifySafe(
                            formatDispatchCallMessage('unicast', targetName, message, fromName),
                            __dirname,
                            { mentionMobiles: profile.phone ? [profile.phone] : [] }
                        );
                    }

                    writeMessageLog(db, {
                        kind: 'unicast',
                        channel,
                        actorUserId: actor.actorUserId,
                        actorUsername: fromName,
                        recipientUserId: userId,
                        recipientUsername: profile.displayName,
                        recipientDisplayName: targetName,
                        message,
                        detail: {
                            terminal_sent: terminalSent,
                            terminal_connected: terminalConnected,
                            wecom: wecomResult,
                            phone: profile.phone || null
                        }
                    });

                    if (typeof ack === 'function') {
                        ack({
                            success: true,
                            channel,
                            terminal_sent: terminalSent,
                            terminal_connected: terminalConnected,
                            wecom: wecomResult
                        });
                    }
                } catch (err) {
                    console.error('单呼失败:', err);
                    if (typeof ack === 'function') ack({ success: false, message: '单呼发送失败' });
                }
            });

            /** 广播：全体(非离线) / 分区 / 自选人员；可选含不可用 */
            socket.on('broadcast_message', async (data, ack) => {
                const admin = requireAdmin();
                if (!admin) {
                    if (typeof ack === 'function') ack({ success: false, message: '需要管理员权限' });
                    return;
                }
                const message = String((data && data.message) || '').trim();
                const channel = normalizeDispatchChannel(data && data.channel);
                const rawAgencies = Array.isArray(data && data.agencies) ? data.agencies : [];
                const rawUserIds = Array.isArray(data && data.userIds) ? data.userIds : [];
                const includeUnavailable = !!(data && (data.includeUnavailable || data.include_unavailable));
                if (!message) {
                    if (typeof ack === 'function') ack({ success: false, message: '请填写广播内容' });
                    return;
                }
                if (message.length > 1000) {
                    if (typeof ack === 'function') ack({ success: false, message: '内容过长（最多 1000 字）' });
                    return;
                }
                if (!channel) {
                    if (typeof ack === 'function') ack({ success: false, message: '请选择发送渠道' });
                    return;
                }
                try {
                    const scoped = await listUsersForBroadcast(db, rawAgencies, {
                        includeUnavailable,
                        userIds: rawUserIds
                    });
                    const targets = scoped.users;
                    if (!targets.length) {
                        if (typeof ack === 'function') {
                            let tip = '当前没有可通知人员（已排除离线';
                            if (!includeUnavailable) tip += '与不可用';
                            tip += '）';
                            if (scoped.mode === 'groups') {
                                tip = '所选分区无人：' + (scoped.agencies.join('、') || '未选择');
                            } else if (scoped.mode === 'users') {
                                tip = '所选人员均不可发送（离线' + (includeUnavailable ? '' : '/不可用') + '）';
                            }
                            ack({ success: false, message: tip });
                        }
                        return;
                    }
                    const actor = actorFromSocket(socket);
                    const fromName = actor.actorUsername || '调度员';
                    let targetLabel;
                    if (scoped.mode === 'users') {
                        targetLabel = `自选 ${targets.length} 人`;
                    } else if (scoped.all) {
                        targetLabel = `全体非离线${includeUnavailable ? '' : '（不含不可用）'}（${targets.length}人）`;
                    } else {
                        targetLabel = `${scoped.agencies.join('、')}（${targets.length}人）`;
                    }
                    const payload = {
                        id: `b-${Date.now()}`,
                        kind: 'broadcast',
                        message,
                        preview: previewMessage(message),
                        from: fromName,
                        scope: scoped.mode,
                        agencies: scoped.agencies,
                        created_at: new Date().toISOString()
                    };

                    let terminalAttempted = 0;
                    let terminalConnected = 0;
                    let wecomResult = null;

                    if (channel === 'terminal' || channel === 'all') {
                        const sent = emitDispatchMessageToUsers(
                            io,
                            targets.map((u) => u.id),
                            payload
                        );
                        terminalAttempted = sent.attempted;
                        terminalConnected = sent.connected;
                    }
                    if (channel === 'wecom' || channel === 'all') {
                        // 全体也按实际名单 @ 手机号（不再盲 @all，避免离线/不可用被 @）
                        const mobiles = targets.map((u) => u.phone).filter(Boolean);
                        const wecomText = formatDispatchCallMessage('broadcast', targetLabel, message, fromName);
                        if (scoped.mode === 'groups') {
                            const byAgency = new Map();
                            for (const u of targets) {
                                const key = String(u.agency || '').trim() || '未分区';
                                if (!byAgency.has(key)) byAgency.set(key, []);
                                byAgency.get(key).push(u);
                            }
                            const groupResults = [];
                            for (const [agencyName, members] of byAgency.entries()) {
                                const m = members.map((u) => u.phone).filter(Boolean);
                                const label = `${agencyName}（${members.length}人）`;
                                const text = formatDispatchCallMessage('broadcast', label, message, fromName);
                                const r = await notifySafe(text, __dirname, { mentionMobiles: m });
                                groupResults.push({ agency: agencyName, mobiles: m.length, result: r });
                            }
                            wecomResult = { groups: groupResults };
                        } else {
                            wecomResult = await notifySafe(wecomText, __dirname, {
                                mentionMobiles: mobiles
                            });
                        }
                    }

                    const wecomSkipped = !!(wecomResult && (wecomResult.skipped || wecomResult.error));
                    const scopeSummary = scoped.mode === 'users'
                        ? '自选人员'
                        : (scoped.all ? '全体非离线' : ('分组 ' + scoped.agencies.join('/')));
                    const batchId = newBatchId();
                    const scopeKey = scoped.mode === 'users' ? 'pick' : (scoped.all ? 'all' : 'agency');
                    for (const u of targets) {
                        writeMessageLog(db, {
                            kind: 'broadcast',
                            channel,
                            batchId,
                            actorUserId: actor.actorUserId,
                            actorUsername: fromName,
                            recipientUserId: u.id,
                            recipientUsername: u.username || null,
                            recipientDisplayName: u.display_name || null,
                            scope: scopeKey,
                            scopeLabel: targetLabel,
                            message,
                            detail: {
                                terminal_sent: terminalAttempted,
                                terminal_connected: terminalConnected,
                                wecom: wecomResult,
                                include_unavailable: includeUnavailable
                            }
                        });
                    }

                    if (typeof ack === 'function') {
                        ack({
                            success: true,
                            channel,
                            count: targets.length,
                            terminal_sent: terminalAttempted,
                            terminal_connected: terminalConnected,
                            wecom: wecomResult,
                            wecom_skipped: wecomSkipped,
                            agencies: scoped.agencies,
                            all: scoped.all,
                            mode: scoped.mode,
                            names: targets.map((u) => u.display_name)
                        });
                    }
                } catch (err) {
                    console.error('广播失败:', err);
                    if (typeof ack === 'function') {
                        ack({ success: false, message: '广播发送失败：' + (err && err.message ? err.message : '未知错误') });
                    }
                }
            });
        });
    }

    return app;
}

module.exports = { createApp };

if (require.main === module) {
    throw new Error('请使用统一入口：在项目根目录执行 npm start（node server.js）');
}
