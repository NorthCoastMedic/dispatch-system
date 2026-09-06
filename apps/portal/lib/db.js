const path = require('path');
const mysql = require('mysql2/promise');
const { loadLocalEnv, envGet } = require('../../_shared/env');

// .env 在 apps/portal/ 下，不在 lib/ 下
const local = loadLocalEnv(path.join(__dirname, '..'));

const pool = mysql.createPool({
    host: envGet(local, 'DB_HOST', '127.0.0.1'),
    port: Number(envGet(local, 'DB_PORT', '3306')),
    user: envGet(local, 'DB_USER', 'org'),
    password: envGet(local, 'DB_PASSWORD', ''),
    database: envGet(local, 'DB_NAME', 'org'),
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4'
});

async function query(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

module.exports = { pool, query, localEnv: local };
