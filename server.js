/**
 * 统一组织系统 - 单端口融合入口
 * 模块：portal / RMS / RTLS / WBGT
 * node server.js
 *
 * 未安装时只提供 /setup.php，不加载业务模块。
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const { loadLocalEnv, envGet } = require('./apps/_shared/env');
const setup = require('./apps/_shared/setup');

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.socket.io https://unpkg.com",
            "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://fonts.googleapis.com https://cdnjs.cloudflare.com",
            "font-src 'self' data: https://fonts.gstatic.com",
            "img-src 'self' data: blob: https:",
            "connect-src 'self' ws: wss: https://cdn.socket.io https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://unpkg.com",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'self'"
        ].join('; ')
    );
    next();
}

function startSetupMode() {
    const rootEnv = loadLocalEnv(__dirname);
    const PORT = Number(envGet(rootEnv, 'PORT', '12000')) || 12000;
    const app = express();
    const server = http.createServer(app);
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(session({
        name: 'beian.sid',
        secret: crypto.randomBytes(32).toString('hex'),
        resave: false,
        saveUninitialized: true,
        cookie: { httpOnly: true, sameSite: 'lax' }
    }));
    app.use('/platform', express.static(path.join(__dirname, 'apps', '_shared', 'public')));
    setup.mount(app, {
        onDone: () => setTimeout(() => process.exit(0), 1500)
    });
    app.use((req, res) => res.redirect('/setup.php'));
    server.listen(PORT, '0.0.0.0', () => {
        console.log('========================================');
        console.log(' 首次安装');
        console.log(` 打开: http://localhost:${PORT}/setup.php`);
        console.log('========================================');
    });
}

function startFull() {
    const { Server } = require('socket.io');
    const { ensureUnifiedSession, requireUnifiedLogin } = require('./apps/_shared/session');
    const {
        loadSettings, saveSettings, getCategoryDefs, ensureReady, redactSettingsForClient
    } = require('./apps/_shared/systemSettings');
    const authTokens = require('./apps/_shared/authTokens');
    const rateLimit = require('./apps/_shared/rateLimit');
    const { createApp: createPortal } = require('./apps/portal');
    const { createApp: createRms } = require('./apps/rms');
    const { createApp: createRtls } = require('./apps/rtls');
    const { createApp: createWbgt } = require('./apps/wbgt');

    const rootEnv = loadLocalEnv(__dirname);
    const PORT = Number(envGet(rootEnv, 'PORT', '12000')) || 12000;
    const SESSION_SECRET = envGet(rootEnv, 'SESSION_SECRET', '');
    const TRUST_PROXY = envGet(rootEnv, 'TRUST_PROXY', '0') === '1';
    const ACCESS_TTL_SEC = Number(envGet(rootEnv, 'TOKEN_ACCESS_TTL_SEC', '900')) || 900;
    const REFRESH_TTL_SEC = Number(envGet(rootEnv, 'TOKEN_REFRESH_TTL_SEC', '86400')) || 86400;

    if (!SESSION_SECRET || SESSION_SECRET === 'beian_unified_secret' || SESSION_SECRET.startsWith('change_me')) {
        console.warn('[安全] 请在根目录 .env 设置强随机 SESSION_SECRET，勿使用示例值。');
    }

    authTokens.configure({
        secret: SESSION_SECRET || ('dev_only_change_me_' + String(PORT)),
        trustProxy: TRUST_PROXY,
        accessTtlSec: ACCESS_TTL_SEC,
        refreshTtlSec: REFRESH_TTL_SEC
    });
    rateLimit.configure({ trustProxy: TRUST_PROXY });

    const app = express();
    const server = http.createServer(app);

    if (TRUST_PROXY) {
        app.set('trust proxy', 1);
    }

    const rmsIo = new Server(server, {
        path: '/rms/socket.io',
        cors: { origin: false }
    });

    const sessionMiddleware = session({
        name: 'beian.sid',
        secret: SESSION_SECRET || 'dev_only_change_me_' + String(PORT),
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: REFRESH_TTL_SEC * 1000,
            httpOnly: true,
            sameSite: 'lax',
            secure: TRUST_PROXY ? true : 'auto'
        }
    });

    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.use(sessionMiddleware);
    app.use(authTokens.middleware);
    rmsIo.engine.use(sessionMiddleware);
    rmsIo.engine.use(authTokens.middleware);

    app.use('/platform', express.static(path.join(__dirname, 'apps', '_shared', 'public')));

    app.get('/api/session', (req, res) => {
        const user = ensureUnifiedSession(req);
        if (!user) return res.json({ success: false });
        const meta = authTokens.tokenMeta(req.auth, req.authRefresh);
        res.json({ success: true, user, auth: meta });
    });

    app.post('/api/auth/refresh', express.json(), (req, res) => {
        authTokens.refreshHandler(req, res);
    });

    app.post('/api/auth/logout', express.json({ strict: false }), (req, res) => {
        authTokens.logoutTokens(req, res);
        if (!req.session) return res.json({ success: true });
        req.session.destroy(() => res.json({ success: true }));
    });

    app.get('/api/system-settings', async (req, res) => {
        try {
            const settings = await loadSettings();
            const user = ensureUnifiedSession(req);
            const includeSecrets = !!(user && user.role === 'admin');
            res.json({
                success: true,
                settings: redactSettingsForClient(settings, includeSecrets),
                categories: getCategoryDefs()
            });
        } catch (err) {
            res.status(500).json({ success: false, message: '读取系统设置失败' });
        }
    });

    app.put('/api/system-settings', express.json(), async (req, res) => {
        const user = ensureUnifiedSession(req);
        if (!user) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        if (user.role !== 'admin') {
            return res.status(403).json({ success: false, message: '需要管理员权限' });
        }
        try {
            const xf = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
            const ip = xf ? String(xf).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || null;
            const result = await saveSettings(
                req.body && req.body.settings ? req.body.settings : req.body,
                { actorUserId: user.id, actorUsername: user.username, ip }
            );
            if (!result.ok) {
                return res.status(400).json({
                    success: false,
                    message: result.errors.join('；'),
                    errors: result.errors,
                    settings: result.settings
                });
            }
            res.json({ success: true, settings: result.settings, message: '系统设置已保存' });
        } catch (err) {
            res.status(500).json({ success: false, message: '保存系统设置失败' });
        }
    });

    ensureReady().catch((err) => {
        console.warn('[systemSettings] 启动预热失败（将在首次请求重试）:', err.message);
    });

    const portalApp = createPortal();
    const rmsApp = createRms({ io: rmsIo });
    const rtlsApp = createRtls();
    const wbgtApp = createWbgt();

    app.use('/rms', rmsApp);
    app.use('/rtls', requireUnifiedLogin, rtlsApp);
    app.use('/wbgt', requireUnifiedLogin, wbgtApp);
    app.use(portalApp);

    server.listen(PORT, '0.0.0.0', () => {
        console.log('========================================');
        console.log(' 统一组织系统');
        console.log(` 单端口: http://localhost:${PORT}`);
        console.log(' 模块: portal / RMS / RTLS / WBGT');
        console.log('========================================');
        console.log(` 门户导航:  http://localhost:${PORT}/dashboard.php`);
        console.log(` RTLS:      http://localhost:${PORT}/rtls/`);
        console.log(` RMS:       http://localhost:${PORT}/rms/`);
        console.log(` WBGT:      http://localhost:${PORT}/wbgt/`);
    });
}

async function main() {
    const needed = await setup.needsSetup();
    if (needed) startSetupMode();
    else startFull();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
