/**
 * 首次安装 / 启动时自动补表（CREATE IF NOT EXISTS，不改已有结构）
 */
const fs = require('fs');
const path = require('path');

function splitSql(sql) {
    const stripped = String(sql || '')
        .split(/\r?\n/)
        .filter((line) => !/^\s*--/.test(line))
        .join('\n');
    return stripped
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
}

async function runSqlFile(conn, filePath) {
    const sql = fs.readFileSync(filePath, 'utf8');
    for (const stmt of splitSql(sql)) {
        await conn.query(stmt);
    }
}

async function ensureOrgSchema(conn) {
    await runSqlFile(conn, path.join(__dirname, 'sql', 'org.sql'));
}

async function ensureRtlsSchema(conn) {
    await runSqlFile(conn, path.join(__dirname, 'sql', 'rtls.sql'));
}

async function ensureWbgtSchema(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS public.wbgt_logs (
            id SERIAL PRIMARY KEY,
            sensor_id VARCHAR(50),
            wbgt FLOAT, ta FLOAT, tg FLOAT, rh FLOAT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

function ident(name, fallback) {
    const s = String(name || '').trim();
    if (/^[A-Za-z0-9_]+$/.test(s)) return s;
    return fallback;
}

module.exports = {
    ensureOrgSchema,
    ensureRtlsSchema,
    ensureWbgtSchema,
    ident
};
