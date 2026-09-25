/**
 * 企业微信通知（可选）
 * 统一使用「自建应用消息」单独发送给个人，不再向群机器人 Webhook 发消息。
 * 配置优先级：系统设置（RMS → 企业微信通知）> apps/rms/.env。
 *
 * 自建应用消息（企业微信 API /cgi-bin/message/send）：
 *   WECOM_ENABLED=1
 *   WECOM_CORP_ID=
 *   WECOM_AGENT_ID=
 *   WECOM_SECRET=
 *
 * 发送对象：传 options.mentionMobiles（志愿者档案绑定的手机号），经
 * user/getuserid 换取企业微信 UserID 后单独发送；原「@全体」场景由调用方
 * 传入成员手机号列表（见 index.js 的 notifyAllMembers）。
 * 注意：企业微信后台需将本服务器 IP 加入「可信企业 IP」，应用需有通讯录权限。
 */

const path = require('path');
const { loadLocalEnv, envGet } = require('../../_shared/env');

let cachedToken = null;
let tokenExpireAt = 0;

function resolveEnvDir(dir) {
    // 允许传入 apps/rms 或 apps/rms/lib
    if (!dir) return path.join(__dirname, '..');
    if (path.basename(dir) === 'lib') return path.join(dir, '..');
    return dir;
}

/** 合并系统设置中的自建应用凭证（优先于 .env） */
async function loadEffectiveEnv(dir) {
    const local = { ...loadLocalEnv(resolveEnvDir(dir)) };
    try {
        const { loadSettings } = require('../../_shared/systemSettings');
        const settings = await loadSettings();
        const rms = (settings && settings.rms) || {};
        const fromSettings = {
            WECOM_CORP_ID: rms.wecom_app_corp_id,
            WECOM_AGENT_ID: rms.wecom_app_agent_id,
            WECOM_SECRET: rms.wecom_app_secret,
            WECOM_API_BASE: rms.wecom_api_base,
            WECOM_API_KEY: rms.wecom_api_key
        };
        for (const [key, value] of Object.entries(fromSettings)) {
            const v = String(value == null ? '' : value).trim();
            if (v) local[key] = v;
        }
        if (hasAppCreds(local)) local.WECOM_ENABLED = '1';
    } catch (err) {
        console.warn('[企业微信] 读取系统设置失败:', err.message);
    }
    return local;
}

function hasAppCreds(local) {
    return !!(
        envGet(local, 'WECOM_CORP_ID', '')
        && envGet(local, 'WECOM_SECRET', '')
        && envGet(local, 'WECOM_AGENT_ID', '')
    );
}

/** 仅自建应用可用；群机器人 Webhook 已停用，不再向群发送 */
function isEnabled(local) {
    if (!hasAppCreds(local)) return false;
    return envGet(local, 'WECOM_ENABLED', '1') !== '0';
}

/** 规范化手机号列表（仅保留数字） */
function normalizeMentionMobiles(list) {
    const arr = Array.isArray(list) ? list : (list != null && list !== '' ? [list] : []);
    return arr
        .map((p) => String(p || '').trim().replace(/[^\d]/g, ''))
        .filter((p) => p.length >= 5 && p.length <= 20);
}

/**
 * 企业微信接口根地址。默认官方域名；可指向自建反向代理（云服务器固定 IP），
 * 解决家宽动态 IP 无法加入「企业可信IP」白名单（errcode 60020）的问题。
 */
function apiBase(local) {
    const raw = String(envGet(local, 'WECOM_API_BASE', '') || '').trim();
    if (!raw) return 'https://qyapi.weixin.qq.com';
    return raw.replace(/\/+$/, '');
}

/** 请求头；配置了 WECOM_API_KEY 时带 X-Proxy-Key，供反代校验来源 */
function apiHeaders(local) {
    const headers = { 'Content-Type': 'application/json' };
    const key = String(envGet(local, 'WECOM_API_KEY', '') || '').trim();
    if (key) headers['X-Proxy-Key'] = key;
    return headers;
}

/** 反代/网关返回 HTML 错误页时的可执行提示 */
const API_HTTP_HINTS = {
    403: 'nginx 反代校验失败：/wecom-api-.../ 里的 X-Proxy-Key 与平台「反代校验密钥」不一致，或请求没带该头',
    404: '反代路径没匹配上：nginx 上没部署 /wecom-api-.../ 段，或平台「接口根地址」路径写错',
    502: '反代连不上企业微信：检查云服务器 SELinux（setsebool -P httpd_can_network_connect 1）与外网出站',
    504: '反代超时：云服务器到 qyapi.weixin.qq.com 不通或很慢'
};

/**
 * 读取接口 JSON；遇到 HTML 错误页时给出可执行提示。
 * 注意不要把完整 URL 写进错误（gettoken 的 query 里带 corpsecret）。
 */
async function readApiJson(res, url) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (_) { /* 交给下面统一报错 */ }
    const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const hint = API_HTTP_HINTS[res.status] || '';
    const apiPath = String(url || '').split('?')[0];
    const msg = `企业微信接口返回的不是 JSON（HTTP ${res.status}${hint ? '；' + hint : ''}）`
        + `，请求 ${apiPath}，响应片段：${snippet || '(空响应)'}`;
    if (res.status === 403 || res.status === 404) blockApi(msg);
    throw new Error(msg);
}

async function getAccessToken(local) {
    const now = Date.now();
    if (cachedToken && now < tokenExpireAt - 60_000) return cachedToken;

    const corpId = envGet(local, 'WECOM_CORP_ID', '');
    const secret = envGet(local, 'WECOM_SECRET', '');
    const url = `${apiBase(local)}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
    const res = await fetch(url, { headers: apiHeaders(local) });
    const data = await readApiJson(res, url);
    if (data.errcode && data.errcode !== 0) {
        markApiBlocked(data.errcode, data.errmsg);
        throw new Error(`获取企业微信 token 失败: ${describeApiError(data.errcode, data.errmsg)}`);
    }
    cachedToken = data.access_token;
    tokenExpireAt = now + (data.expires_in || 7200) * 1000;
    return cachedToken;
}

/* ---------- 手机号 → UserID（带缓存，减少接口调用） ---------- */
const userIdCache = new Map();
const USERID_HIT_TTL = 6 * 60 * 60 * 1000;
const USERID_MISS_TTL = 5 * 60 * 1000;
/** 手机号不存在 / 成员不存在：短时间内不重复请求 */
const USER_NOT_FOUND_CODES = new Set([46004, 60111]);

/* ---------- 接口配置类错误：给出可执行提示，并短暂停止重试 ---------- */
/** 这类错误短时间内重试也不会成功（IP 白名单 / 权限 / 凭证等） */
const API_BLOCK_CODES = new Set([60020, 60011, 40013, 40001, 41001, 42001, 40014]);
const API_BLOCK_TTL = 5 * 60 * 1000;
let apiBlockedUntil = 0;
let apiBlockedReason = '';

function describeApiError(errcode, errmsg) {
    const code = Number(errcode);
    const raw = String(errmsg || '').trim();
    if (code === 60020) {
        const m = /from ip:\s*([\d.]+)/i.exec(raw);
        const ipText = m ? `（当前出口 IP ${m[1]}）` : '';
        return `访问 IP 不在企业微信可信IP白名单${ipText}：请在 企业微信管理后台 → 应用管理 → 自建 → 你的应用 →「企业可信IP」中添加该 IP`;
    }
    if (code === 60011) return '自建应用缺少通讯录权限：请在应用详情里开通「通讯录」相关权限';
    if (code === 40013) return 'AgentId 无效：请核对自建应用 AgentId';
    if (code === 40001 || code === 41001) return 'Secret 无效或已重置：请重新填写自建应用 Secret';
    if (code === 42001 || code === 40014) return 'access_token 失效或非法：稍后会自动重试';
    return raw || `errcode ${code}`;
}

function blockApi(reason) {
    apiBlockedReason = reason;
    apiBlockedUntil = Date.now() + API_BLOCK_TTL;
}

function markApiBlocked(errcode, errmsg) {
    const code = Number(errcode);
    if (!API_BLOCK_CODES.has(code)) return;
    blockApi(describeApiError(code, errmsg));
}

/** 冷却中则直接跳过，不再请求接口（避免反复失败的请求与日志） */
function apiBlockedResult() {
    const now = Date.now();
    if (now >= apiBlockedUntil) return null;
    const minutes = Math.max(1, Math.ceil((apiBlockedUntil - now) / 60000));
    return {
        skipped: true,
        reason: `企业微信接口已暂停调用（${apiBlockedReason}），约 ${minutes} 分钟后自动重试`
    };
}

async function resolveUserIdByMobile(mobile, local) {
    const key = String(mobile || '').replace(/[^\d]/g, '');
    if (!key) return '';
    const now = Date.now();
    const hit = userIdCache.get(key);
    if (hit && now - hit.at < (hit.userId ? USERID_HIT_TTL : USERID_MISS_TTL)) {
        return hit.userId;
    }

    const token = await getAccessToken(local);
    const url = `${apiBase(local)}/cgi-bin/user/getuserid?access_token=${token}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(local),
        body: JSON.stringify({ mobile: key })
    });
    const data = await readApiJson(res, url);
    if (data.errcode === 0 && data.userid) {
        const userId = String(data.userid);
        userIdCache.set(key, { userId, at: now });
        return userId;
    }
    if (USER_NOT_FOUND_CODES.has(Number(data.errcode))) {
        userIdCache.set(key, { userId: '', at: now });
        console.warn('[企业微信] 手机号', key, '未匹配到成员:', data.errmsg || data.errcode);
        return '';
    }
    markApiBlocked(data.errcode, data.errmsg);
    throw new Error(`手机号获取 UserID 失败: ${describeApiError(data.errcode, data.errmsg)}`);
}

/** 批量手机号 → UserID；返回 { userIds, unresolved } */
async function resolveUserIdsByMobiles(mobiles, local) {
    const out = { userIds: [], unresolved: [] };
    for (const mobile of normalizeMentionMobiles(mobiles)) {
        const userId = await resolveUserIdByMobile(mobile, local);
        if (userId) out.userIds.push(userId);
        else out.unresolved.push(mobile);
    }
    return out;
}

/** 文本按 UTF-8 字节数截断（应用消息正文上限 2048 字节） */
const APP_TEXT_MAX_BYTES = 2048;
function clampUtf8Bytes(text, maxBytes) {
    const s = String(text == null ? '' : text);
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    const budget = maxBytes - 3;
    let out = '';
    let bytes = 0;
    for (const ch of s) {
        const len = Buffer.byteLength(ch, 'utf8');
        if (bytes + len > budget) break;
        out += ch;
        bytes += len;
    }
    return out + '…';
}

/**
 * 自建应用消息：按 UserID 单独发送（touser 多人时企业微信仍逐人单聊下发）
 * @param {string} content
 * @param {object} local
 * @param {{ mentionMobiles?: string|string[], mentionAll?: boolean, userIds?: string[] }} options
 */
async function sendViaApp(content, local, options = {}) {
    const agentId = Number(envGet(local, 'WECOM_AGENT_ID', '0'));
    if (!agentId) throw new Error('未配置企业微信 AgentId');

    const direct = Array.isArray(options.userIds)
        ? options.userIds.map((v) => String(v == null ? '' : v).trim()).filter(Boolean)
        : [];
    const mobiles = direct.length ? [] : normalizeMentionMobiles(options.mentionMobiles);

    let userIds = direct;
    let unresolved = [];
    if (!userIds.length && mobiles.length) {
        const resolved = await resolveUserIdsByMobiles(mobiles, local);
        userIds = resolved.userIds;
        unresolved = resolved.unresolved;
    }
    userIds = [...new Set(userIds)];

    let touser = '';
    if (userIds.length) {
        touser = userIds.slice(0, 1000).join('|');
    } else if (!mobiles.length && options.mentionAll) {
        // 兜底：调用方未提供手机号时才用 @all（应用可见范围内全体成员）
        touser = '@all';
    } else {
        return { skipped: true, reason: '手机号未匹配到企业微信成员', unresolved };
    }

    const token = await getAccessToken(local);
    const url = `${apiBase(local)}/cgi-bin/message/send?access_token=${token}`;
    const body = {
        touser,
        msgtype: 'text',
        agentid: agentId,
        text: { content: clampUtf8Bytes(content, APP_TEXT_MAX_BYTES) },
        safe: 0,
        enable_duplicate_check: 0
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(local),
        body: JSON.stringify(body)
    });
    const data = await readApiJson(res, url);
    if (data.errcode && data.errcode !== 0) {
        markApiBlocked(data.errcode, data.errmsg);
        throw new Error(`企业微信发送失败: ${describeApiError(data.errcode, data.errmsg)}`);
    }
    return {
        ok: true,
        via: 'app',
        agentid: agentId,
        targets: touser === '@all' ? 'all' : userIds.length,
        touser,
        unresolved,
        invaliduser: data.invaliduser || '',
        msgid: data.msgid || ''
    };
}

/**
 * 统一发送入口：始终走自建应用消息，单独发送给个人
 * @param {string} content
 * @param {string} [dir]
 * @param {{ mentionMobiles?: string|string[], mentionAll?: boolean, userIds?: string[] }} [options]
 */
async function sendTextToAll(content, dir = __dirname, options = {}) {
    const blocked = apiBlockedResult();
    if (blocked) return blocked;
    const local = await loadEffectiveEnv(dir);
    if (!isEnabled(local)) {
        return { skipped: true, reason: '未启用企业微信自建应用（缺少 企业ID / AgentId / Secret）' };
    }
    return sendViaApp(content, local, options);
}

function notifySafe(content, dir, options) {
    return sendTextToAll(content, dir, options).catch((err) => {
        console.error('[企业微信]', err.message);
        return { ok: false, error: err.message };
    });
}

/** users.id → volunteers.phone（经 volunteer_id） */
async function lookupPhoneByUserId(db, userId) {
    if (!userId || !db) return '';
    const [rows] = await db.query(
        `SELECT v.phone AS phone
         FROM users u
         LEFT JOIN volunteers v ON v.id = u.volunteer_id
         WHERE u.id = ?
         LIMIT 1`,
        [userId]
    );
    const phone = rows[0]?.phone != null ? String(rows[0].phone).trim() : '';
    return phone;
}

/** 批量查手机号；返回 { userId, phone, displayName, agency }[] */
async function lookupPhonesByUserIds(db, userIds) {
    const ids = [...new Set((userIds || []).map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    if (!ids.length || !db) return [];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT u.id AS user_id,
                IFNULL(v.phone, '') AS phone,
                IFNULL(NULLIF(TRIM(v.name), ''), u.username) AS display_name,
                IFNULL(v.agency, '') AS agency
         FROM users u
         LEFT JOIN volunteers v ON v.id = u.volunteer_id
         WHERE u.id IN (${placeholders})`,
        ids
    );
    return (rows || []).map((r) => ({
        userId: Number(r.user_id),
        phone: r.phone != null ? String(r.phone).trim() : '',
        displayName: r.display_name || String(r.user_id),
        agency: r.agency != null ? String(r.agency).trim() : ''
    }));
}

const REPORT_TYPES = ['医疗事件求助', '安全问题求助', '其他问题求助'];

function normalizeReportType(raw) {
    const t = String(raw || '').trim();
    if (REPORT_TYPES.includes(t)) return t;
    return '';
}

function parseReportType(description) {
    const text = String(description || '');
    const m = text.match(/^【([^】]+)】/);
    if (m) {
        if (REPORT_TYPES.includes(m[1])) return m[1];
        if (m[1] === '外部上报') return '其他问题求助';
    }
    if (text.includes('【外部上报】')) return '其他问题求助';
    return '';
}

/** 拼装 description：联系方式 + 详细情况 + 可选备注；reportType 有值时加类型前缀 */
function buildEventDescription(contact, details, reportType = null, remark = '') {
    const lines = [
        `联系方式：${String(contact || '').trim()}`,
        `详细情况：${String(details || '').trim()}`
    ];
    const r = String(remark || '').trim();
    if (r) lines.push(`备注：${r}`);
    const body = lines.join('\n');
    // 兼容旧调用：true → 其他问题求助；字符串 → 指定类型
    let type = '';
    if (reportType === true) type = '其他问题求助';
    else if (typeof reportType === 'string') type = normalizeReportType(reportType) || parseReportType(`【${reportType}】`) || '';
    return type ? `【${type}】\n${body}` : body;
}

/** 从 description 解析联系方式、详细情况与备注（兼容旧「地点：」格式） */
function parseEventLocationDetails(description) {
    const text = String(description || '').trim();
    let work = text;
    let remark = '';
    const remarkIdx = work.search(/\n备注[：:]/);
    if (remarkIdx >= 0) {
        remark = work.slice(remarkIdx).replace(/^\n备注[：:]\s*/, '').trim();
        work = work.slice(0, remarkIdx);
    } else {
        const onlyRemark = work.match(/^备注[：:]\s*([\s\S]*)$/);
        if (onlyRemark) {
            remark = onlyRemark[1].trim();
            work = '';
        }
    }

    const contactMatch = work.match(/联系方式[：:]\s*([^\n\r]*)/);
    const detailsMatch = work.match(/详细情况[：:]\s*([\s\S]*)/);
    const locMatch = text.match(/地点[：:]\s*([^\n\r]+)/);

    let contact = contactMatch ? contactMatch[1].trim() : '';
    let details = detailsMatch ? detailsMatch[1].trim() : '';

    if (!contact && !details) {
        details = work
            .replace(/【[^】]+】\s*/g, '')
            .replace(/地点[：:][^\n\r]*\s*/g, '')
            .trim();
    }
    if (!details) details = '无';

    // location 仅兼容旧数据；新数据地点在 events.title
    const location = locMatch ? locMatch[1].trim() : '未填写';
    return { contact: contact || '未填写', details, remark, location, report_type: parseReportType(text) };
}

function formatAssignMessage(username, title, contact, details) {
    return [
        '新的指派：',
        `人员：${username}`,
        `事件地点：${title}`,
        `联系方式：${contact}`,
        `详细情况：${details}`
    ].join('\n');
}

function formatUnassignMessage(username, title, contact, details) {
    return [
        '取消指派：',
        `人员：${username}`,
        `事件地点：${title}`,
        `联系方式：${contact}`,
        `详细情况：${details}`
    ].join('\n');
}

function formatEmergencyMessage(username) {
    return `${username}成员激活了紧急报警`;
}

function formatNewEventMessage(title, contact, details, reportType = '') {
    const lines = ['新的事件：'];
    if (reportType) lines.push(`求助类型：${reportType}`);
    lines.push(
        `事件地点：${title}`,
        `联系方式：${contact}`,
        `详细情况：${details}`
    );
    return lines.join('\n');
}

function formatCompleteEventMessage(title, contact, details) {
    return [
        '事件完成：',
        `事件地点：${title}`,
        `联系方式：${contact}`,
        `详细情况：${details}`
    ].join('\n');
}

function formatDispatchCallMessage(kind, targetLabel, message, fromName) {
    const title = kind === 'broadcast' ? '[调度广播]' : '[调度单呼]';
    return [
        title,
        `发件人：${fromName || '调度员'}`,
        `对象：${targetLabel || '—'}`,
        `内容：${String(message || '').trim()}`
    ].join('\n');
}

module.exports = {
    isEnabled,
    sendTextToAll,
    notifySafe,
    lookupPhoneByUserId,
    lookupPhonesByUserIds,
    normalizeMentionMobiles,
    REPORT_TYPES,
    normalizeReportType,
    parseReportType,
    buildEventDescription,
    parseEventLocationDetails,
    formatAssignMessage,
    formatUnassignMessage,
    formatEmergencyMessage,
    formatNewEventMessage,
    formatCompleteEventMessage,
    formatDispatchCallMessage
};
