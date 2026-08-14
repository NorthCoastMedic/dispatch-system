/**
 * 进程内滑动窗口限流（不改表）。TRUST_PROXY=1 时才信 X-Forwarded-For。
 */

let trustProxy = false;

function configure(opts) {
    if (opts && opts.trustProxy != null) trustProxy = !!opts.trustProxy;
}

function clientIp(req) {
    if (trustProxy) {
        const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
        if (xf) return String(xf).split(',')[0].trim();
    }
    return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

function createLimiter({ windowMs, max }) {
    const buckets = new Map();
    let lastPrune = 0;

    function prune(now) {
        if (now - lastPrune < 60000) return;
        lastPrune = now;
        for (const [k, b] of buckets) {
            if (!b || now >= b.resetAt) buckets.delete(k);
        }
    }

    function bucket(key, now) {
        prune(now);
        let b = buckets.get(key);
        if (!b || now >= b.resetAt) {
            b = { count: 0, resetAt: now + windowMs };
            buckets.set(key, b);
        }
        return b;
    }

    return {
        isBlocked(key) {
            const now = Date.now();
            const b = buckets.get(key);
            if (!b || now >= b.resetAt) return { blocked: false, retryAfter: 0 };
            if (b.count >= max) {
                return { blocked: true, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
            }
            return { blocked: false, retryAfter: 0 };
        },
        fail(key) {
            const now = Date.now();
            const b = bucket(key, now);
            b.count += 1;
            return {
                blocked: b.count >= max,
                retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000))
            };
        },
        hit(key) {
            const now = Date.now();
            const blocked = this.isBlocked(key);
            if (blocked.blocked) return { ok: false, retryAfter: blocked.retryAfter };
            const b = bucket(key, now);
            b.count += 1;
            if (b.count > max) {
                return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
            }
            return { ok: true, retryAfter: 0 };
        },
        reset(key) {
            buckets.delete(key);
        }
    };
}

const loginIp = createLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const loginUser = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const publicReport = createLimiter({ windowMs: 10 * 60 * 1000, max: 12 });
const searchGet = createLimiter({ windowMs: 60 * 1000, max: 40 });
const certGet = createLimiter({ windowMs: 60 * 1000, max: 90 });

function loginGate(req, username) {
    const ip = clientIp(req);
    const u = String(username || '').trim().toLowerCase() || '-';
    const a = loginIp.isBlocked('ip:' + ip);
    const b = loginUser.isBlocked('u:' + u);
    if (a.blocked || b.blocked) {
        return { ok: false, retryAfter: Math.max(a.retryAfter, b.retryAfter) };
    }
    return { ok: true, retryAfter: 0 };
}

function loginFail(req, username) {
    const ip = clientIp(req);
    const u = String(username || '').trim().toLowerCase() || '-';
    loginIp.fail('ip:' + ip);
    loginUser.fail('u:' + u);
}

function loginOk(req, username) {
    const ip = clientIp(req);
    const u = String(username || '').trim().toLowerCase() || '-';
    loginIp.reset('ip:' + ip);
    loginUser.reset('u:' + u);
}

module.exports = {
    configure,
    clientIp,
    createLimiter,
    loginGate,
    loginFail,
    loginOk,
    publicReport,
    searchGet,
    certGet
};
