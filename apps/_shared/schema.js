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

function tableNameFromCreate(stmt) {
    const m = String(stmt || '').match(
        /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?[`"]?([A-Za-z0-9_]+)/i
    );
    return m ? m[1] : null;
}

function countCreateTables(filePath) {
    const sql = fs.readFileSync(filePath, 'utf8');
    let n = 0;
    for (const stmt of splitSql(sql)) {
        if (tableNameFromCreate(stmt)) n += 1;
    }
    return n;
}

async function runSqlFile(conn, filePath, onTable) {
    const sql = fs.readFileSync(filePath, 'utf8');
    for (const stmt of splitSql(sql)) {
        await conn.query(stmt);
        const name = tableNameFromCreate(stmt);
        if (name && typeof onTable === 'function') {
            await onTable(name);
        }
    }
}

async function ensureOrgSchema(conn, onTable) {
    await runSqlFile(conn, path.join(__dirname, 'sql', 'org.sql'), onTable);
}

async function ensureRtlsSchema(conn, onTable) {
    await runSqlFile(conn, path.join(__dirname, 'sql', 'rtls.sql'), onTable);
}

async function ensureWbgtSchema(client, onTable) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS public.wbgt_logs (
            id SERIAL PRIMARY KEY,
            sensor_id VARCHAR(50),
            wbgt FLOAT, ta FLOAT, tg FLOAT, rh FLOAT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    if (typeof onTable === 'function') await onTable('wbgt_logs');
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
    countCreateTables,
    ident
};
