/**
 * PWA 支撑（仅业务模式使用）
 *
 * - Service Worker 必须从站点根路径提供，作用域才能覆盖门户与 /rms/，因此单挂一个 /sw.js 路由；
 * - manifest 由系统设置动态生成（安装名称 / 短名称 / 主题色），必须在 /platform 静态目录之前注册；
 * - 图标只需维护一张 512×512 源图 icon-source.png，其余尺寸在启动时自动派生；
 *   「系统设置 → PWA」上传的图标会重新编码成标准 PNG 写入该源图，再派生各尺寸。
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');

const { loadSettings } = require('./systemSettings');
const { ensureUnifiedSession } = require('./session');
const { verifyCsrf } = require('../portal/lib/helpers');

const PWA_DIR = path.join(__dirname, 'public', 'pwa');
const SW_FILE = path.join(PWA_DIR, 'sw.js');
const ICON_SOURCE = path.join(PWA_DIR, 'icon-source.png');

/** 图标上传：只收内存，限制 2MB 单文件 */
const iconUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 }
}).single('icon');

/** maskable 图标的外圈底色（源图会被缩到 80% 居中放置） */
const MASK_BG = '#0056b3';
const DEFAULT_THEME = '#0056b3';

const ICON_TARGETS = [
    { file: 'icon-192.png', size: 192, maskable: false },
    { file: 'icon-512.png', size: 512, maskable: false },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
    { file: 'apple-touch-icon.png', size: 180, maskable: false }
];

function mount(app) {
    app.get('/sw.js', (req, res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Service-Worker-Allowed', '/');
        res.type('application/javascript; charset=utf-8');
        res.sendFile(SW_FILE, { cacheControl: false }, (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    });

    app.get('/platform/pwa/manifest.webmanifest', async (req, res) => {
        let settings = null;
        try {
            settings = await loadSettings();
        } catch (err) {
            /* 读不到设置时用内置默认值，保证 manifest 始终可用 */
        }
        res.type('application/manifest+json');
        res.set('Cache-Control', 'no-cache');
        res.json(buildManifest(settings));
    });

    app.post('/api/pwa-icon', (req, res) => {
        const user = ensureUnifiedSession(req);
        if (!user) return res.status(401).json({ success: false, message: '未登录' });
        if (user.role !== 'admin') return res.status(403).json({ success: false, message: '需要管理员权限' });

        iconUpload(req, res, async (err) => {
            if (err) {
                const tooBig = err.code === 'LIMIT_FILE_SIZE';
                return res.status(400).json({
                    success: false,
                    message: tooBig ? '图片不能超过 2MB' : '上传失败，请重试'
                });
            }
            if (!verifyCsrf(req)) {
                return res.status(403).json({ success: false, message: 'CSRF 校验失败，请刷新页面后重试。' });
            }
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({ success: false, message: '请选择图片文件' });
            }
            try {
                // 重新编码成标准 512×512 PNG：统一尺寸，同时丢弃原文件里的其它数据
                const png = await require('sharp')(req.file.buffer)
                    .resize(512, 512, { fit: 'cover' })
                    .png()
                    .toBuffer();
                fs.writeFileSync(ICON_SOURCE, png);
                const result = await ensureIcons();
                return res.json({
                    success: true,
                    built: (result && result.built) || [],
                    message: '图标已更新（手机端重新打开或下拉刷新后生效）'
                });
            } catch (e) {
                return res.status(400).json({ success: false, message: '不是有效的图片文件，仅支持 PNG / JPG' });
            }
        });
    });
}

function pickThemeColor(raw) {
    const v = String(raw || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_THEME;
}

/** manifest 的 id / start_url / scope 决定"只有一个 App"，不要随意改动 */
function buildManifest(settings) {
    const branding = (settings && settings.branding) || {};
    const pwa = (settings && settings.pwa) || {};
    const fallback = String(branding.internal_platform_name || '').trim() || '统一平台';
    const name = String(pwa.name || '').trim() || fallback;
    const shortName = (String(pwa.short_name || '').trim() || name).slice(0, 24);
    return {
        id: '/dashboard.php',
        name,
        short_name: shortName,
        description: '组织统一平台：队员档案、公开检索、现场响应调度。断网时响应终端可继续切换状态，联网后自动上传。',
        start_url: '/dashboard.php',
        scope: '/',
        display: 'standalone',
        background_color: '#dfe3e8',
        theme_color: pickThemeColor(pwa.theme_color),
        lang: 'zh-CN',
        icons: [
            { src: '/platform/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/platform/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/platform/pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
    };
}

/**
 * 由 icon-source.png 派生各尺寸图标；源图比产物新时才会重新生成。
 * 缺少源图或 sharp 不可用时静默跳过（保留现有占位图标）。
 */
async function ensureIcons() {
    if (!fs.existsSync(ICON_SOURCE)) return { skipped: true, reason: '缺少 icon-source.png' };

    let sharp;
    try {
        sharp = require('sharp');
    } catch (e) {
        return { skipped: true, reason: 'sharp 不可用' };
    }

    const sourceMtime = fs.statSync(ICON_SOURCE).mtimeMs;
    const built = [];

    for (const target of ICON_TARGETS) {
        const out = path.join(PWA_DIR, target.file);
        if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= sourceMtime) continue;

        if (target.maskable) {
            const inner = Math.round(target.size * 0.8);
            const logo = await sharp(ICON_SOURCE).resize(inner, inner, { fit: 'cover' }).png().toBuffer();
            await sharp({
                create: {
                    width: target.size,
                    height: target.size,
                    channels: 4,
                    background: MASK_BG
                }
            })
                .composite([{ input: logo, gravity: 'center' }])
                .png()
                .toFile(out);
        } else {
            await sharp(ICON_SOURCE).resize(target.size, target.size, { fit: 'cover' }).png().toFile(out);
        }
        built.push(target.file);
    }

    return { built };
}

module.exports = { mount, ensureIcons, PWA_DIR, ICON_SOURCE };
