'use strict';

const crypto = require('crypto');
const path = require('path');

let secret = '';
let ttlSec = 30 * 60;

function configure(opts) {
    if (!opts) return;
    if (opts.secret) secret = String(opts.secret);
    if (opts.ttlSec > 0) ttlSec = Number(opts.ttlSec);
}

function getSecret() {
    if (!secret) throw new Error('SESSION_SECRET 未配置');
    return secret;
}

function basename(file) {
    return path.basename(String(file || '')).replace(/[/\\]/g, '');
}

function hmac(file, exp) {
    return crypto.createHmac('sha256', getSecret()).update(file + '\n' + String(exp)).digest('hex').slice(0, 32);
}

function equal(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

function certUrl(file) {
    const name = basename(file);
    if (!name) return '';
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const t = hmac(name, exp);
    return '/get_cert.php?file=' + encodeURIComponent(name) + '&exp=' + exp + '&t=' + t;
}

function avatarUrl(file) {
    const name = basename(file);
    if (!name) return '';
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const t = hmac(name, exp);
    return '/get_avatar.php?file=' + encodeURIComponent(name) + '&exp=' + exp + '&t=' + t;
}

function verifyQuery(query) {
    const file = basename(query && query.file);
    const exp = parseInt(query && query.exp, 10);
    const t = String((query && query.t) || '');
    if (!file || !/^[0-9a-f]{32}$/i.test(t) || !Number.isFinite(exp)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (now >= exp) return null;
    if (exp > now + ttlSec + 60) return null;
    if (!equal(t, hmac(file, exp))) return null;
    return file;
}

module.exports = { configure, certUrl, avatarUrl, verifyQuery, basename };
