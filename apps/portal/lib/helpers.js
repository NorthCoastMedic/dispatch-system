const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ensureCsrf(req) {
    if (!req.session.csrf_token) {
        req.session.csrf_token = crypto.randomBytes(32).toString('hex');
    }
    return req.session.csrf_token;
}

function verifyCsrf(req) {
    const token = req.body && req.body.csrf_token;
    return token && req.session.csrf_token && token === req.session.csrf_token;
}

async function verifyPassword(plain, hash) {
    if (!hash) return false;
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
        const normalized = hash.replace(/^\$2y\$/, '$2b$');
        return bcrypt.compare(plain, normalized);
    }
    // 开源版仅接受 bcrypt；拒绝明文哈希兼容
    return false;
}

async function hashPassword(plain) {
    return bcrypt.hash(plain, 10);
}

function passwordMeetsPolicy(plain) {
    const s = String(plain || '');
    return s.length >= 8 && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

function passwordPolicyMessage() {
    return '密码须至少 8 位，且同时包含大写字母、小写字母和数字。';
}

function formatDateInput(value) {
    if (!value) return '';
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}

module.exports = {
    escapeHtml,
    ensureCsrf,
    verifyCsrf,
    verifyPassword,
    hashPassword,
    passwordMeetsPolicy,
    passwordPolicyMessage,
    formatDateInput
};
