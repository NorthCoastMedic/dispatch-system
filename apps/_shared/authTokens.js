/**
 * Access JWT（短时、带 exp）+ Refresh JWT（长时、可撤销）
 * 浏览器：HttpOnly Cookie；API：可用 Authorization: Bearer
 */
const crypto = require('crypto');

const COOKIE_AT = 'beian.at';
const COOKIE_RT = 'beian.rt';

let secret = '';
let trustProxy = false;
let accessTtlSec = 15 * 60;
let refreshTtlSec = 24 * 60 * 60;
let pool = null;

/** jti -> { userId, username, role, volunteer_id, familyId, exp, revoked } */
const refreshStore = new Map();

function configure(opts) {
    if (!opts) return;
    if (opts.secret) secret = String(opts.secret);
    if (opts.trustProxy != null) trustProxy = !!opts.trustProxy;
    if (opts.accessTtlSec > 0) accessTtlSec = Number(opts.accessTtlSec);
    if (opts.refreshTtlSec > 0) refreshTtlSec = Number(opts.refreshTtlSec);
    if (opts.pool) pool = opts.pool;
}

function getSecret() {
    if (!secret) {
        throw new Error('SESSION_SECRET 未配置');
    }
    return secret;
}

function b64urlJson(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function signJwt(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const h = b64urlJson(header);
    const p = b64urlJson(payload);
    const sig = crypto.createHmac('sha256', getSecret()).update(h + '.' + p).digest('base64url');
    return h + '.' + p + '.' + sig;
}

function verifyJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expect = crypto.createHmac('sha256', getSecret()).update(h + '.' + p).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && now >= Number(payload.exp)) return { expired: true, payload };
    return { expired: false, payload };
}

function parseCookies(req) {
    const hdr = String((req && req.headers && req.headers.cookie) || '');
    const out = {};
    hdr.split(';').forEach((part) => {
        const i = part.indexOf('=');
        if (i < 0) return;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        try {
            out[k] = decodeURIComponent(v);
        } catch {
            out[k] = v;
        }
    });
    return out;
}

function readBearer(req) {
    const h = String((req && req.headers && req.headers.authorization) || '');
    const m = h.match(/^Bearer\s+(\S+)/i);
    return m ? m[1] : '';
}

function cookieSecure(req) {
    if (trustProxy) return true;
    return !!(req && req.secure);
}

function serializeCookie(name, value, req, extra) {
    const opts = extra || {};
    const parts = [`${name}=${encodeURIComponent(value == null ? '' : String(value))}`];
    parts.push('Path=' + (opts.path || '/'));
    if (opts.maxAgeSec != null) parts.push('Max-Age=' + Math.max(0, Number(opts.maxAgeSec)));
    parts.push('HttpOnly');
    parts.push('SameSite=Lax');
    if (cookieSecure(req)) parts.push('Secure');
    return parts.join('; ');
}

function appendCookie(res, line) {
    if (!res) return;
    if (typeof res.append === 'function') {
        res.append('Set-Cookie', line);
        return;
    }
    if (typeof res.setHeader !== 'function') return;
    const prev = res.getHeader('Set-Cookie');
    const list = prev == null ? [] : (Array.isArray(prev) ? prev.slice() : [String(prev)]);
    list.push(line);
    res.setHeader('Set-Cookie', list);
}

function userFromClaims(payload) {
    if (!payload || payload.sub == null) return null;
    const id = parseInt(payload.sub, 10);
    if (!id) return null;
    return {
        id,
        username: payload.username,
        role: payload.role,
        volunteer_id: payload.volunteer_id || null
    };
}

function claimsForUser(user, extra) {
    const now = Math.floor(Date.now() / 1000);
    return Object.assign({
        sub: String(user.id),
        username: user.username,
        role: user.role,
        volunteer_id: user.volunteer_id || null,
        iat: now
    }, extra || {});
}

function persistRefreshRec(jti, rec) {
    if (!pool || !jti || !rec) return;
    pool.query(
        `INSERT INTO auth_refresh_tokens
         (jti, user_id, username, role, volunteer_id, family_id, exp, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id),
           username = VALUES(username),
           role = VALUES(role),
           volunteer_id = VALUES(volunteer_id),
           family_id = VALUES(family_id),
           exp = VALUES(exp),
           revoked = VALUES(revoked)`,
        [
            jti,
            rec.userId,
            rec.username || null,
            rec.role || null,
            rec.volunteer_id != null ? rec.volunteer_id : null,
            rec.familyId,
            rec.exp,
            rec.revoked ? 1 : 0
        ]
    ).catch((err) => console.warn('[auth] 刷新令牌写入失败:', err.message));
}

function deleteRefreshRec(jti) {
    if (!pool || !jti) return;
    pool.query('DELETE FROM auth_refresh_tokens WHERE jti = ?', [jti])
        .catch((err) => console.warn('[auth] 刷新令牌删除失败:', err.message));
}

function pruneRefreshStore() {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, rec] of refreshStore) {
        if (!rec || rec.revoked || rec.exp <= now) refreshStore.delete(jti);
    }
    if (pool) {
        pool.query('DELETE FROM auth_refresh_tokens WHERE exp <= ? OR revoked = 1', [now])
            .catch(() => {});
    }
}

async function hydrateRefreshStore() {
    if (!pool) return;
    const now = Math.floor(Date.now() / 1000);
    const [rows] = await pool.query(
        `SELECT jti, user_id, username, role, volunteer_id, family_id, exp, revoked
         FROM auth_refresh_tokens
         WHERE revoked = 0 AND exp > ?`,
        [now]
    );
    refreshStore.clear();
    for (const row of rows || []) {
        refreshStore.set(row.jti, {
            userId: row.user_id,
            username: row.username,
            role: row.role,
            volunteer_id: row.volunteer_id || null,
            familyId: row.family_id,
            exp: Number(row.exp),
            revoked: false
        });
    }
}

function issueTokenPair(user) {
    pruneRefreshStore();
    const now = Math.floor(Date.now() / 1000);
    const familyId = crypto.randomBytes(12).toString('hex');
    const atJti = crypto.randomBytes(10).toString('hex');
    const rtJti = crypto.randomBytes(12).toString('hex');
    const accessPayload = claimsForUser(user, {
        typ: 'access',
        jti: atJti,
        exp: now + accessTtlSec
    });
    const refreshPayload = claimsForUser(user, {
        typ: 'refresh',
        jti: rtJti,
        fid: familyId,
        exp: now + refreshTtlSec
    });
    refreshStore.set(rtJti, {
        userId: user.id,
        username: user.username,
        role: user.role,
        volunteer_id: user.volunteer_id || null,
        familyId,
        exp: refreshPayload.exp,
        revoked: false
    });
    persistRefreshRec(rtJti, refreshStore.get(rtJti));
    return {
        accessToken: signJwt(accessPayload),
        refreshToken: signJwt(refreshPayload),
        accessClaims: accessPayload,
        refreshClaims: refreshPayload
    };
}

function rotateRefresh(oldPayload) {
    const rec = refreshStore.get(oldPayload.jti);
    if (!rec || rec.revoked) return null;
    rec.revoked = true;
    refreshStore.delete(oldPayload.jti);
    deleteRefreshRec(oldPayload.jti);
    const user = {
        id: rec.userId,
        username: rec.username,
        role: rec.role,
        volunteer_id: rec.volunteer_id
    };
    const now = Math.floor(Date.now() / 1000);
    const remain = Math.max(60, rec.exp - now);
    const rtJti = crypto.randomBytes(12).toString('hex');
    const atJti = crypto.randomBytes(10).toString('hex');
    const accessPayload = claimsForUser(user, { typ: 'access', jti: atJti, exp: now + accessTtlSec });
    const refreshPayload = claimsForUser(user, {
        typ: 'refresh',
        jti: rtJti,
        fid: rec.familyId,
        exp: now + remain
    });
    refreshStore.set(rtJti, {
        userId: user.id,
        username: user.username,
        role: user.role,
        volunteer_id: rec.volunteer_id,
        familyId: rec.familyId,
        exp: refreshPayload.exp,
        revoked: false
    });
    persistRefreshRec(rtJti, refreshStore.get(rtJti));
    return {
        accessToken: signJwt(accessPayload),
        refreshToken: signJwt(refreshPayload),
        accessClaims: accessPayload,
        refreshClaims: refreshPayload,
        user
    };
}

function accessFromRefresh(payload) {
    const rec = refreshStore.get(payload.jti);
    if (!rec || rec.revoked) return null;
    const now = Math.floor(Date.now() / 1000);
    if (rec.exp <= now) {
        refreshStore.delete(payload.jti);
        deleteRefreshRec(payload.jti);
        return null;
    }
    const user = {
        id: rec.userId,
        username: rec.username,
        role: rec.role,
        volunteer_id: rec.volunteer_id
    };
    const accessPayload = claimsForUser(user, {
        typ: 'access',
        jti: crypto.randomBytes(10).toString('hex'),
        exp: now + accessTtlSec
    });
    return { accessToken: signJwt(accessPayload), accessClaims: accessPayload, user };
}

function revokeRefreshToken(token) {
    const v = verifyJwt(token);
    const payload = v && v.payload;
    if (!payload || payload.typ !== 'refresh' || !payload.jti) return;
    const rec = refreshStore.get(payload.jti);
    if (rec) {
        rec.revoked = true;
        refreshStore.delete(payload.jti);
        deleteRefreshRec(payload.jti);
    }
}

function setAuthCookies(req, res, pair) {
    appendCookie(res, serializeCookie(COOKIE_AT, pair.accessToken, req, { maxAgeSec: accessTtlSec }));
    appendCookie(res, serializeCookie(COOKIE_RT, pair.refreshToken, req, { maxAgeSec: refreshTtlSec }));
}

function clearAuthCookies(req, res) {
    appendCookie(res, serializeCookie(COOKIE_AT, '', req, { maxAgeSec: 0 }));
    appendCookie(res, serializeCookie(COOKIE_RT, '', req, { maxAgeSec: 0 }));
}

function tokenMeta(accessClaims, refreshClaims) {
    const exp = accessClaims && accessClaims.exp ? Number(accessClaims.exp) : 0;
    const rexp = refreshClaims && refreshClaims.exp ? Number(refreshClaims.exp) : 0;
    return {
        token_type: 'Bearer',
        expires_in: Math.max(0, exp - Math.floor(Date.now() / 1000)),
        expires_at: exp ? new Date(exp * 1000).toISOString() : null,
        refresh_expires_at: rexp ? new Date(rexp * 1000).toISOString() : null
    };
}

function issueForUser(req, res, user, opts) {
    const pair = issueTokenPair(user);
    setAuthCookies(req, res, pair);
    const json = tokenMeta(pair.accessClaims, pair.refreshClaims);
    if (opts && opts.includeTokens) {
        json.access_token = pair.accessToken;
        json.refresh_token = pair.refreshToken;
    }
    req.auth = pair.accessClaims;
    req.authRefresh = pair.refreshClaims;
    return json;
}

function applyUserToSession(req, user) {
    if (!req || !req.session || !user) return;
    req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        volunteer_id: user.volunteer_id || null
    };
    req.session.user_id = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.volunteer_id = user.volunteer_id || null;
}

function middleware(req, res, next) {
    const cookies = parseCookies(req);
    const bearer = readBearer(req);
    const at = bearer || cookies[COOKIE_AT] || '';
    const rt = cookies[COOKIE_RT] || '';

    const atv = at ? verifyJwt(at) : null;
    if (atv && !atv.expired && atv.payload && atv.payload.typ === 'access') {
        req.auth = atv.payload;
        applyUserToSession(req, userFromClaims(atv.payload));
        return next();
    }

    const rtv = rt ? verifyJwt(rt) : null;
    if (rtv && !rtv.expired && rtv.payload && rtv.payload.typ === 'refresh') {
        const issued = accessFromRefresh(rtv.payload);
        if (issued) {
            appendCookie(res, serializeCookie(COOKIE_AT, issued.accessToken, req, { maxAgeSec: accessTtlSec }));
            req.auth = issued.accessClaims;
            applyUserToSession(req, issued.user);
            return next();
        }
    }

    return next();
}

function refreshHandler(req, res) {
    const cookies = parseCookies(req);
    const body = req.body || {};
    const raw = body.refresh_token || cookies[COOKIE_RT] || '';
    const rtv = raw ? verifyJwt(raw) : null;
    if (!rtv || rtv.expired || !rtv.payload || rtv.payload.typ !== 'refresh') {
        return res.status(401).json({ success: false, message: '刷新令牌无效或已过期，请重新登录' });
    }
    const rotated = body.refresh_token
        ? rotateRefresh(rtv.payload)
        : null;
    const issued = rotated || accessFromRefresh(rtv.payload);
    if (!issued) {
        return res.status(401).json({ success: false, message: '刷新令牌已失效，请重新登录' });
    }
    if (rotated) {
        setAuthCookies(req, res, rotated);
        applyUserToSession(req, rotated.user);
        req.auth = rotated.accessClaims;
        const meta = tokenMeta(rotated.accessClaims, rotated.refreshClaims);
        return res.json({
            success: true,
            user: rotated.user,
            ...meta,
            access_token: rotated.accessToken,
            refresh_token: rotated.refreshToken
        });
    }
    appendCookie(res, serializeCookie(COOKIE_AT, issued.accessToken, req, { maxAgeSec: accessTtlSec }));
    applyUserToSession(req, issued.user);
    req.auth = issued.accessClaims;
    return res.json({
        success: true,
        user: issued.user,
        ...tokenMeta(issued.accessClaims, rtv.payload)
    });
}

function logoutTokens(req, res) {
    const cookies = parseCookies(req);
    revokeRefreshToken(cookies[COOKIE_RT] || '');
    if (req.body && req.body.refresh_token) revokeRefreshToken(req.body.refresh_token);
    clearAuthCookies(req, res);
}

function isCrossSiteGet(req) {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return true;
    if (site === 'same-origin' || site === 'same-site' || site === 'none') return false;
    const ref = String(req.headers.origin || req.headers.referer || '');
    if (!ref) return false;
    try {
        const host = String(req.headers.host || '');
        return new URL(ref).host !== host;
    } catch {
        return true;
    }
}

module.exports = {
    COOKIE_AT,
    COOKIE_RT,
    configure,
    hydrateRefreshStore,
    middleware,
    issueForUser,
    refreshHandler,
    logoutTokens,
    clearAuthCookies,
    tokenMeta,
    userFromClaims,
    isCrossSiteGet,
    getAccessTtlSec: () => accessTtlSec,
    getRefreshTtlSec: () => refreshTtlSec
};
