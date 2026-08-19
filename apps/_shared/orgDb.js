/**
 * 组织主库连接（门户 .env）。会话与刷新令牌与系统设置共用。
 */
const path = require('path');
const mysql = require('mysql2/promise');
const { loadLocalEnv, envGet } = require('./env');

let pool = null;

function getOrgPool() {
    if (pool) return pool;
    const portalEnv = loadLocalEnv(path.join(__dirname, '..', 'portal'));
    pool = mysql.createPool({
        host: envGet(portalEnv, 'DB_HOST', '127.0.0.1'),
        port: Number(envGet(portalEnv, 'DB_PORT', '3306')),
        user: envGet(portalEnv, 'DB_USER', 'org'),
        password: envGet(portalEnv, 'DB_PASSWORD', ''),
        database: envGet(portalEnv, 'DB_NAME', 'org'),
        waitForConnections: true,
        connectionLimit: 10,
        charset: 'utf8mb4'
    });
    return pool;
}

async function ensureSessionTables(db) {
    const conn = db || getOrgPool();
    await conn.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id VARCHAR(128) NOT NULL,
          expires INT UNSIGNED NOT NULL,
          data MEDIUMTEXT,
          PRIMARY KEY (session_id),
          KEY idx_sessions_expires (expires)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
          jti VARCHAR(64) NOT NULL,
          user_id INT NOT NULL,
          username VARCHAR(64) NULL,
          role VARCHAR(32) NULL,
          volunteer_id INT NULL,
          family_id VARCHAR(64) NOT NULL,
          exp INT UNSIGNED NOT NULL,
          revoked TINYINT NOT NULL DEFAULT 0,
          PRIMARY KEY (jti),
          KEY idx_art_user (user_id),
          KEY idx_art_exp (exp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

module.exports = { getOrgPool, ensureSessionTables };
