'use strict';

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateSecret(bytes) {
    const buf = crypto.randomBytes(bytes || 20);
    return base32Encode(buf);
}

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < buf.length; i++) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const clean = String(str || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (let i = 0; i < clean.length; i++) {
        const idx = B32.indexOf(clean[i]);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function hotp(secretBuf, counter, digits) {
    const msg = Buffer.alloc(8);
    msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    msg.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    const mod = 10 ** (digits || 6);
    return String(bin % mod).padStart(digits || 6, '0');
}

function totpAt(secret, timeSec, digits, period) {
    const p = period || 30;
    const counter = Math.floor(timeSec / p);
    return hotp(base32Decode(secret), counter, digits || 6);
}

function verifyTotp(secret, code, opts) {
    const digits = (opts && opts.digits) || 6;
    const period = (opts && opts.period) || 30;
    const window = opts && opts.window != null ? opts.window : 1;
    const expected = String(code || '').replace(/\s/g, '');
    if (!/^\d{6,8}$/.test(expected)) return false;
    const now = Math.floor(Date.now() / 1000);
    for (let w = -window; w <= window; w++) {
        const gen = totpAt(secret, now + w * period, digits, period);
        const a = Buffer.from(gen, 'utf8');
        const b = Buffer.from(expected.padStart(digits, '0').slice(-digits), 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
}

function otpauthUrl(secret, account, issuer) {
    const iss = encodeURIComponent(String(issuer || 'Platform').slice(0, 40));
    const acc = encodeURIComponent(String(account || 'user').slice(0, 64));
    return `otpauth://totp/${iss}:${acc}?secret=${encodeURIComponent(secret)}&issuer=${iss}&digits=6&period=30`;
}

module.exports = {
    generateSecret,
    verifyTotp,
    otpauthUrl,
    totpAt
};
