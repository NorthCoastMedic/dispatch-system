/**
 * 企业微信通知（可选）
 * 优先使用系统设置 RMS.wecom_webhook_url；否则读 apps/rms/.env：
 *
 * 1) 群机器人 Webhook（推荐，无需固定 IP）：
 *   WECOM_ENABLED=1
 *   WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
 *
 * 2) 自建应用消息（需企业可信 IP）：
 *   WECOM_ENABLED=1
 *   WECOM_CORP_ID=
 *   WECOM_AGENT_ID=
 *   WECOM_SECRET=
 *
 * Webhook @人：传 options.mentionMobiles（志愿者档案手机号），不 @全体。
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

/** 合并系统设置中的 Webhook（优先于 .env） */
async function loadEffectiveEnv(dir) {
    const local = { ...loadLocalEnv(resolveEnvDir(dir)) };
    try {
        const { loadSettings } = require('../../_shared/systemSettings');
        const settings = await loadSettings();
        const url = settings && settings.rms && String(settings.rms.wecom_webhook_url || '').trim();
        if (url) {
            local.WECOM_WEBHOOK_URL = url;
            if (!local.WECOM_ENABLED) local.WECOM_ENABLED = '1';
        }
    } catch (err) {
        console.warn('[企业微信] 读取系统设置 Webhook 失败:', err.message);
    }
    return local;
}

function hasWebhook(local) {
    return !!envGet(local, 'WECOM_WEBHOOK_URL', '');
}

function hasAppCreds(local) {
    return !!(
        envGet(local, 'WECOM_CORP_ID', '')
        && envGet(local, 'WECOM_SECRET', '')
        && envGet(local, 'WECOM_AGENT_ID', '')
    );
}

function isEnabled(local) {
    // 系统设置或 .env 已配 Webhook 时即可用；否则需 WECOM_ENABLED=1 + 应用凭证
    if (hasWebhook(local)) return true;
    if (envGet(local, 'WECOM_ENABLED', '') !== '1') return false;
    return hasAppCreds(local);
}

/** 规范化手机号列表（仅保留数字） */
function normalizeMentionMobiles(list) {
    const arr = Array.isArray(list) ? list : (list != null && list !== '' ? [list] : []);
    return arr
        .map((p) => String(p || '').trim().replace(/[^\d]/g, ''))
        .filter((p) => p.length >= 5 && p.length <= 20);
}

async function getAccessToken(local) {
    const now = Date.now();
    if (cachedToken && now < tokenExpireAt - 60_000) return cachedToken;

    const corpId = envGet(local, 'WECOM_CORP_ID', '');
    const secret = envGet(local, 'WECOM_SECRET', '');
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
        throw new Error(`获取企业微信 token 失败: ${data.errmsg || data.errcode}`);
    }
    cachedToken = data.access_token;
    tokenExpireAt = now + (data.expires_in || 7200) * 1000;
    return cachedToken;
}

async function sendViaWebhook(content, local, options = {}) {
    const url = envGet(local, 'WECOM_WEBHOOK_URL', '');
    const mobiles = normalizeMentionMobiles(options.mentionMobiles);
    const text = {
        content: String(content).slice(0, 2048)
    };
    if (options.mentionAll) {
        // 紧急等场景：@全体
        text.mentioned_list = ['@all'];
    } else if (mobiles.length) {
        // 指派等场景：只 @ 指定手机号
        text.mentioned_mobile_list = mobiles;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text })
    });
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
        throw new Error(`企业微信 Webhook 发送失败: ${data.errmsg || data.errcode}`);
    }
    return { ok: true, via: 'webhook', mentioned: options.mentionAll ? ['@all'] : mobiles, data };
}

async function sendViaApp(content, local) {
    const token = await getAccessToken(local);
    const agentId = Number(envGet(local, 'WECOM_AGENT_ID', '0'));
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const body = {
        touser: '@all',
        msgtype: 'text',
        agentid: agentId,
        text: { content: String(content).slice(0, 2000) },
        safe: 0,
        enable_duplicate_check: 0
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
        throw new Error(`企业微信发送失败: ${data.errmsg || data.errcode}`);
    }
    return { ok: true, via: 'app', data };
}

/**
 * @param {string} content
 * @param {string} [dir]
 * @param {{ mentionMobiles?: string|string[], mentionAll?: boolean }} [options]
 */
async function sendTextToAll(content, dir = __dirname, options = {}) {
    const local = await loadEffectiveEnv(dir);
    if (!isEnabled(local)) {
        return { skipped: true, reason: '未启用企业微信（未配置 Webhook / WECOM_ENABLED）' };
    }

    if (hasWebhook(local)) {
        return sendViaWebhook(content, local, options);
    }
    return sendViaApp(content, local);
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

/** 公开上报类型（写入 description 前缀【类型】） */
const REPORT_TYPES = ['医疗事件求助', '安全问题求助', '其他问题求助'];

function normalizeReportType(raw) {
    const t = String(raw || '').trim();
    if (REPORT_TYPES.includes(t)) return t;
    return '';
}

/** 从 description 解析公开上报类型；兼容旧【外部上报】 */
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
    const title = kind === 'broadcast' ? '【调度广播】' : '【调度单呼】';
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
