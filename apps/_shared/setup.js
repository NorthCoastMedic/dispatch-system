/**
 * 首次安装：仅在未完成安装时出现。
 * 用户自行填写组织名称 / 管理员 / 数据库，表由系统创建。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { loadLocalEnv } = require('./env');
const { ident, ensureOrgSchema, ensureRtlsSchema, ensureWbgtSchema, countCreateTables } = require('./schema');

const ROOT = path.join(__dirname, '..', '..');
const LOCK = path.join(__dirname, 'data', 'install.lock');
const PAGE = path.join(__dirname, 'setup.html');

const setupHits = new Map();

function envLine(key, value) {
    const s = String(value == null ? '' : value);
    if (/[\s#"\\]/.test(s) || s.includes("'")) {
        return key + '="' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return key + '=' + s;
}

function writeEnvFile(filePath, pairs) {
    const body = pairs.map(([k, v]) => envLine(k, v)).join('\n') + '\n';
    fs.writeFileSync(filePath, body, 'utf8');
}

function hasLock() {
    return fs.existsSync(LOCK);
}

function writeLock(note) {
    const dir = path.dirname(LOCK);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({
        at: new Date().toISOString(),
        note: note || 'installed'
    }, null, 2), 'utf8');
}

function portalEnvFilled(local) {
    return !!(local && String(local.DB_HOST || '').trim() && String(local.DB_NAME || '').trim() && String(local.DB_USER || '').trim());
}

async function needsSetup() {
    if (hasLock()) return false;
    const portalDir = path.join(ROOT, 'apps', 'portal');
    const local = loadLocalEnv(portalDir);
    if (!portalEnvFilled(local)) return true;
    try {
        const conn = await mysql.createConnection({
            host: local.DB_HOST,
            port: Number(local.DB_PORT || 3306),
            user: local.DB_USER,
            password: local.DB_PASSWORD || '',
            database: local.DB_NAME,
            connectTimeout: 5000
        });
        const [tables] = await conn.query("SHOW TABLES LIKE 'users'");
        if (!tables.length) {
            await conn.end();
            return true;
        }
        const [admins] = await conn.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
        await conn.end();
        if (!admins.length) return true;
        writeLock('detected-existing');
        return false;
    } catch {
        // 已有库配置但暂时连不上：绝不进入安装页，避免覆盖生产 .env
        return false;
    }
}

function setupRateOk(ip) {
    const now = Date.now();
    const rec = setupHits.get(ip) || { n: 0, resetAt: now + 15 * 60 * 1000 };
    if (now >= rec.resetAt) {
        rec.n = 0;
        rec.resetAt = now + 15 * 60 * 1000;
    }
    rec.n += 1;
    setupHits.set(ip, rec);
    return rec.n <= 8;
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const SETUP_FIELDS = [
    'internal_platform_name', 'login_title', 'rms_terminal_title', 'rms_display_title',
    'public_site_url', 'public_site_label', 'footer_copyright', 'footer_motto',
    'admin_username', 'admin_password', 'admin_password2',
    'db_host', 'db_port', 'db_user', 'db_password', 'db_name', 'rtls_db_name',
    'pg_host', 'pg_port', 'pg_user', 'pg_password', 'pg_database',
    'port', 'mqtt_broker'
];

function pickValues(body) {
    const out = {};
    const src = body || {};
    for (const key of SETUP_FIELDS) {
        if (src[key] == null) continue;
        out[key] = String(src[key]);
    }
    return out;
}

function renderPage(csrf, error, values) {
    let html = fs.readFileSync(PAGE, 'utf8');
    html = html.replace('{{CSRF}}', escapeHtml(csrf));
    html = html.replace('{{ERROR}}', error
        ? '<div class="err" id="setup-err">✖ ' + escapeHtml(error) + '</div>'
        : '<div class="err" id="setup-err" hidden></div>');
    html = html.replace(
        '{{VALUES_JSON}}',
        JSON.stringify(pickValues(values)).replace(/</g, '\\u003c')
    );
    return html;
}

function successPage() {
    return '<!DOCTYPE html><meta charset="utf-8"><title>安装完成</title>'
        + '<style>body{font-family:sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#222}'
        + 'h1{font-size:22px;margin:0 0 8px;color:#0056b3}'
        + '.lead{color:#667;margin:0 0 24px;font-size:14px}'
        + '.ok{background:#fff;border-radius:12px;padding:40px 28px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.06)}'
        + '.ok h2{color:#0056b3}</style>'
        + '<h1>首次安装</h1>'
        + '<p class="lead">只需这一次。填组织名称、管理员和数据库，表由系统自动创建。完成后请重新运行 <code>npm start</code> 再登录。</p>'
        + '<div class="ok"><h2>安装成功，请重新启动服务</h2><p>本窗口对应的进程即将退出。</p></div>';
}

function trim(v) {
    return String(v == null ? '' : v).trim();
}

async function runInstall(body, onProgress) {
    const branding = {
        internal_platform_name: trim(body.internal_platform_name),
        login_title: trim(body.login_title),
        rms_terminal_title: trim(body.rms_terminal_title),
        rms_display_title: trim(body.rms_display_title),
        public_site_url: trim(body.public_site_url),
        public_site_label: trim(body.public_site_label),
        footer_copyright: trim(body.footer_copyright),
        footer_motto: trim(body.footer_motto)
    };
    const adminUser = trim(body.admin_username);
    const adminPass = String(body.admin_password || '');
    const adminPass2 = String(body.admin_password2 || '');
    const dbHost = trim(body.db_host);
    const dbPort = Number(trim(body.db_port) || 3306) || 3306;
    const dbUser = trim(body.db_user);
    const dbPass = String(body.db_password || '');
    const dbName = ident(body.db_name, '');
    const rtlsName = ident(body.rtls_db_name, '');
    const port = Number(trim(body.port) || 12000) || 12000;
    const mqtt = trim(body.mqtt_broker);
    const pgHost = trim(body.pg_host);
    const pgUser = trim(body.pg_user);
    const pgPass = String(body.pg_password || '');
    const pgDb = ident(body.pg_database, '');
    const pgPort = Number(trim(body.pg_port) || 5432) || 5432;

    if (!branding.internal_platform_name || !branding.login_title) {
        throw new Error('请填写内部平台名称和登录页标题');
    }
    if (!branding.rms_terminal_title || !branding.rms_display_title) {
        throw new Error('请填写响应终端标题和状态展示页标题');
    }
    if (!branding.public_site_url || !branding.public_site_label || !branding.footer_copyright) {
        throw new Error('请填写公开网站网址、链接文案和页脚版权行');
    }
    try {
        const u = new URL(branding.public_site_url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad');
    } catch {
        throw new Error('公开网站网址必须以 http:// 或 https:// 开头');
    }
    if (!adminUser) throw new Error('请填写管理员用户名');
    if (adminPass.length < 8) throw new Error('管理员密码至少 8 位');
    if (adminPass !== adminPass2) throw new Error('两次输入的管理员密码不一致');
    if (!dbHost || !dbUser || !dbName) throw new Error('请填写 MySQL 主机、用户名和主库名');
    if (!rtlsName) throw new Error('请填写 RTLS 库名');
    if (!/^[A-Za-z0-9_]+$/.test(dbName) || !/^[A-Za-z0-9_]+$/.test(rtlsName)) {
        throw new Error('数据库名只能包含字母、数字和下划线');
    }

    const orgSql = path.join(__dirname, 'sql', 'org.sql');
    const rtlsSql = path.join(__dirname, 'sql', 'rtls.sql');
    const wantWbgt = !!(pgHost && pgUser && pgDb);
    const total = countCreateTables(orgSql) + countCreateTables(rtlsSql) + (wantWbgt ? 1 : 0);
    let current = 0;
    const emit = (label) => {
        if (typeof onProgress === 'function') {
            onProgress({ current, total, label: label || '' });
        }
    };
    const onTable = async (name, scope) => {
        current += 1;
        emit('正在写入数据表 ' + current + ' / ' + total + '（' + (scope ? scope + '.' : '') + name + '）');
    };

    emit('正在连接 MySQL');

    const rootConn = await mysql.createConnection({
        host: dbHost,
        port: dbPort,
        user: dbUser,
        password: dbPass,
        multipleStatements: false,
        connectTimeout: 10000
    });
    emit('正在创建数据库');
    try {
        await rootConn.query(
            'CREATE DATABASE IF NOT EXISTS `' + dbName + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
        );
        await rootConn.query(
            'CREATE DATABASE IF NOT EXISTS `' + rtlsName + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
        );
    } finally {
        await rootConn.end();
    }

    const orgConn = await mysql.createConnection({
        host: dbHost, port: dbPort, user: dbUser, password: dbPass, database: dbName
    });
    try {
        await ensureOrgSchema(orgConn, (name) => onTable(name, '主库'));
        const hash = await bcrypt.hash(adminPass, 10);
        const [exists] = await orgConn.query('SELECT id FROM users WHERE username = ? LIMIT 1', [adminUser]);
        if (exists.length) {
            await orgConn.query(
                "UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?",
                [hash, exists[0].id]
            );
        } else {
            await orgConn.query(
                "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'admin', 1)",
                [adminUser, hash]
            );
        }
        const now = new Date().toISOString();
        const brandingRows = Object.entries(branding);
        for (const [key, value] of brandingRows) {
            await orgConn.query(
                `INSERT INTO settings (category, setting_key, setting_value)
                 VALUES ('branding', ?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                [key, value]
            );
        }
        await orgConn.query(
            `INSERT INTO org_settings_logs (action, actor_username, category, summary, after_json)
             VALUES ('install', ?, 'branding', '首次安装写入系统信息', CAST(? AS JSON))`,
            [adminUser, JSON.stringify({ branding, at: now })]
        );
    } finally {
        await orgConn.end();
    }

    const rtlsConn = await mysql.createConnection({
        host: dbHost, port: dbPort, user: dbUser, password: dbPass, database: rtlsName
    });
    try {
        await ensureRtlsSchema(rtlsConn, (name) => onTable(name, 'RTLS'));
    } finally {
        await rtlsConn.end();
    }

    if (wantWbgt) {
        const { Client } = require('pg');
        const adminPg = new Client({
            host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: 'postgres'
        });
        await adminPg.connect();
        try {
            const found = await adminPg.query('SELECT 1 FROM pg_database WHERE datname = $1', [pgDb]);
            if (!found.rowCount) {
                await adminPg.query('CREATE DATABASE "' + pgDb + '"');
            }
        } finally {
            await adminPg.end();
        }
        const wbgtPg = new Client({
            host: pgHost, port: pgPort, user: pgUser, password: pgPass, database: pgDb
        });
        await wbgtPg.connect();
        try {
            await ensureWbgtSchema(wbgtPg, (name) => onTable(name, 'WBGT'));
        } finally {
            await wbgtPg.end();
        }
    }

    emit('正在写入配置');

    const sessionSecret = crypto.randomBytes(32).toString('hex');
    writeEnvFile(path.join(ROOT, '.env'), [
        ['PORT', String(port)],
        ['SESSION_SECRET', sessionSecret],
        ['TRUST_PROXY', '0'],
        ['TOKEN_ACCESS_TTL_SEC', '900'],
        ['TOKEN_REFRESH_TTL_SEC', '86400']
    ]);
    const mysqlPairs = [
        ['DB_HOST', dbHost],
        ['DB_PORT', String(dbPort)],
        ['DB_USER', dbUser],
        ['DB_PASSWORD', dbPass],
        ['DB_NAME', dbName]
    ];
    writeEnvFile(path.join(ROOT, 'apps', 'portal', '.env'), mysqlPairs);
    writeEnvFile(path.join(ROOT, 'apps', 'rms', '.env'), mysqlPairs.concat([
        ['WECOM_ENABLED', '0'],
        ['WECOM_WEBHOOK_URL', '']
    ]));
    writeEnvFile(path.join(ROOT, 'apps', 'rtls', '.env'), [
        ['DB_HOST', dbHost],
        ['DB_USER', dbUser],
        ['DB_PASSWORD', dbPass],
        ['DB_NAME', rtlsName],
        ['MQTT_BROKER_URL', mqtt],
        ['MQTT_TOPIC_FILTER', 'owntracks/#']
    ]);
    writeEnvFile(path.join(ROOT, 'apps', 'wbgt', '.env'), [
        ['MQTT_BROKER', mqtt],
        ['PG_HOST', pgHost],
        ['PG_USER', pgUser],
        ['PG_PASSWORD', pgPass],
        ['PG_DATABASE', pgDb],
        ['PG_PORT', String(pgPort)]
    ]);

    writeLock('wizard');
    emit(total ? ('数据表已写入 ' + total + ' / ' + total) : '安装完成');
    return { port };
}

function mount(app, opts) {
    const onDone = opts && opts.onDone;

    app.get(['/setup.php', '/setup', '/'], (req, res) => {
        if (!req.session.csrf_token) {
            req.session.csrf_token = crypto.randomBytes(24).toString('hex');
        }
        res.set('Cache-Control', 'no-store');
        res.type('html').send(renderPage(req.session.csrf_token, ''));
    });

    app.post('/setup.php', async (req, res) => {
        const ip = (req.socket && req.socket.remoteAddress) || '0.0.0.0';
        const body = req.body || {};
        const stream = String(req.headers.accept || '').includes('ndjson')
            || body.setup_stream === '1';
        const fail = (status, message) => {
            if (stream) {
                if (!res.headersSent) {
                    res.status(status);
                    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
                    res.set('Cache-Control', 'no-store');
                }
                res.end(JSON.stringify({ type: 'error', message }) + '\n');
                return;
            }
            res.status(status).type('html').send(renderPage(req.session.csrf_token || '', message, body));
        };
        if (!setupRateOk(ip)) {
            return fail(429, '尝试次数过多，请稍后再试');
        }
        if (!req.session.csrf_token || body.csrf_token !== req.session.csrf_token) {
            return fail(403, '安全校验失败，请刷新页面后重试');
        }
        if (stream) {
            res.status(200);
            res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.set('Cache-Control', 'no-store');
            res.set('X-Accel-Buffering', 'no');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            const send = (obj) => {
                res.write(JSON.stringify(obj) + '\n');
                if (typeof res.flush === 'function') res.flush();
            };
            try {
                const result = await runInstall(body, (p) => send({ type: 'progress', ...p }));
                send({ type: 'done', port: result.port });
                res.end();
                if (typeof onDone === 'function') onDone(result);
            } catch (err) {
                console.error('[setup]', err);
                send({ type: 'error', message: err.message || '安装失败' });
                res.end();
            }
            return;
        }
        try {
            const result = await runInstall(body);
            res.type('html').send(successPage());
            if (typeof onDone === 'function') onDone(result);
        } catch (err) {
            console.error('[setup]', err);
            if (!req.session.csrf_token) {
                req.session.csrf_token = crypto.randomBytes(24).toString('hex');
            }
            res.status(400).type('html').send(renderPage(req.session.csrf_token, err.message || '安装失败', body));
        }
    });
}

module.exports = { needsSetup, mount, hasLock };
