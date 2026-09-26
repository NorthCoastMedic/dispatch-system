const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

/** 只读本模块 .env，不污染/覆盖全局 process.env（多库并存） */
function loadLocalEnv(dir) {
    const envPath = path.join(dir, '.env');
    if (!fs.existsSync(envPath)) return {};
    return dotenv.parse(fs.readFileSync(envPath));
}

function envGet(local, key, fallback = '') {
    if (local[key] !== undefined && local[key] !== '') return local[key];
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
    return fallback;
}

module.exports = { loadLocalEnv, envGet };
