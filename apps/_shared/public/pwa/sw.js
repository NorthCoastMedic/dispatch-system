/**
 * 统一平台 Service Worker（单一 PWA：入口为门户 /dashboard.php）
 *
 * 目标：
 * - 有网时：门户内所有功能（含 RTLS / WBGT）全部照常走网络；
 * - 无网/弱网时：门户能打开上次访问过的页面快照；RMS 响应终端能打开并继续本地排队，联网后自动上传。
 *
 * 原则：
 * - 只处理 GET；/api/*、socket.io 一律直连，绝不缓存（避免串号、脏数据）；
 * - 门户页面按需快照（network-first），登录/登出时清空，防止换账号后串号；
 * - 同源静态资源与已知 CDN 走 stale-while-revalidate。
 */
const VERSION = 'v2-20260926';
const SHELL_CACHE = 'up-shell-' + VERSION;
const RUNTIME_CACHE = 'up-runtime-' + VERSION;
const PAGE_CACHE = 'up-pages-' + VERSION;

const OFFLINE_PAGE = '/platform/pwa/offline.html';
const RMS_SHELL_KEYS = ['/rms/index.html', '/rms/'];
const RMS_ENTRY = '/rms/';

/** 允许运行时缓存的同源路径前缀 */
const SAME_ORIGIN_CACHEABLE = ['/rms/', '/platform/', '/assets/'];

/** 允许运行时缓存的跨域静态资源主机 */
const CDN_HOSTS = [
    'cdn.tailwindcss.com',
    'cdn.socket.io',
    'cdnjs.cloudflare.com',
    'unpkg.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

/** 不缓存快照的页面：登录/登出（出现即代表已登出，需清理页面快照） */
const NO_SNAPSHOT_PAGES = ['/login.php', '/logout.php'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const shell = await caches.open(SHELL_CACHE);
        await shell.add(new Request(OFFLINE_PAGE, { cache: 'reload' })).catch(() => {});
        await precacheRmsShell(shell);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((key) => [SHELL_CACHE, RUNTIME_CACHE, PAGE_CACHE].indexOf(key) === -1)
                .map((key) => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let url;
    try {
        url = new URL(req.url);
    } catch (e) {
        return;
    }

    if (url.origin === self.location.origin) {
        if (isApiPath(url.pathname) || isRealtimePath(url.pathname)) return;
        if (req.mode === 'navigate') {
            event.respondWith(handleNavigation(req, url));
            return;
        }
        if (isSameOriginCacheable(url.pathname)) {
            event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
        }
        return;
    }

    if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
        event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    }
});

function isApiPath(pathname) {
    return /(^|\/)api\//.test(pathname);
}

function isRealtimePath(pathname) {
    return pathname.indexOf('/socket.io') !== -1;
}

function isSameOriginCacheable(pathname) {
    if (isApiPath(pathname) || isRealtimePath(pathname)) return false;
    return SAME_ORIGIN_CACHEABLE.some((prefix) => pathname.indexOf(prefix) === 0);
}

function isRmsEntry(pathname) {
    return pathname === '/rms/' || pathname === '/rms/index.html';
}

function isHtmlResponse(resp) {
    const type = resp.headers.get('Content-Type') || '';
    return type.indexOf('text/html') !== -1;
}

/** 响应的最终落地路径（同源）；跨域或异常返回 null */
function finalPath(resp) {
    try {
        const finalUrl = new URL(resp.url);
        if (finalUrl.origin !== self.location.origin) return null;
        return finalUrl.pathname;
    } catch (e) {
        return null;
    }
}

/* ---------------- 页面导航 ---------------- */

async function handleNavigation(req, url) {
    const pathname = url.pathname;

    if (NO_SNAPSHOT_PAGES.indexOf(pathname) !== -1) {
        try {
            const resp = await fetch(req);
            if (pathname === '/login.php') purgePageCache();
            return resp;
        } catch (e) {
            return (await matchOfflinePage()) || offlineResponse();
        }
    }

    try {
        const resp = await fetch(req);
        if (resp && isHtmlResponse(resp)) {
            const landed = finalPath(resp);
            if (landed === '/login.php') {
                // 会话失效被踢回登录页：不写快照，并清掉旧快照防止串号
                purgePageCache();
            } else if (resp.ok && landed === url.pathname) {
                cachePage(req, resp.clone());
            }
        }
        return resp;
    } catch (e) {
        /* 断网：走快照 */
    }

    return (await matchSnapshot(req, url)) || offlineResponse();
}

async function cachePage(req, resp) {
    try {
        const cache = await caches.open(PAGE_CACHE);
        await cache.put(req, resp);
    } catch (e) { /* 忽略配额等异常 */ }
}

async function purgePageCache() {
    try {
        await caches.delete(PAGE_CACHE);
    } catch (e) { /* 忽略 */ }
}

async function matchSnapshot(req, url) {
    try {
        const pages = await caches.open(PAGE_CACHE);
        const hit = await pages.match(req);
        if (hit) return hit;
    } catch (e) { /* 忽略 */ }

    if (isRmsEntry(url.pathname)) {
        const shell = await caches.open(SHELL_CACHE);
        for (const key of RMS_SHELL_KEYS) {
            const hit = await shell.match(key);
            if (hit) return hit;
        }
    }

    return matchOfflinePage();
}

async function matchOfflinePage() {
    try {
        const shell = await caches.open(SHELL_CACHE);
        return (await shell.match(OFFLINE_PAGE)) || null;
    } catch (e) {
        return null;
    }
}

function offlineResponse() {
    return new Response('当前离线，且本机没有可用的离线副本。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

/* ---------------- RMS 终端外壳预缓存 ---------------- */

/**
 * 安装时抓一次 /rms/，连同它引用的同源资源与已知 CDN 一起缓存，
 * 这样即使没单独打开过终端，断网也能进入页面继续排队操作。
 */
async function precacheRmsShell(shell) {
    try {
        const resp = await fetch(new Request(RMS_ENTRY, { cache: 'reload', credentials: 'same-origin' }));
        if (!resp || !resp.ok || !isHtmlResponse(resp)) return;
        // 未登录时 /rms/ 会被重定向到登录页，别把登录页当成终端外壳缓存
        if (RMS_SHELL_KEYS.indexOf(finalPath(resp)) === -1) return;

        const html = await resp.clone().text();
        for (const key of RMS_SHELL_KEYS) {
            await shell.put(key, resp.clone()).catch(() => {});
        }

        const urls = new Set();
        const pageUrl = new URL(RMS_ENTRY, self.location.origin);
        const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
        let match;
        while ((match = re.exec(html))) {
            const raw = match[1];
            if (!raw || raw.indexOf('data:') === 0 || raw.indexOf('#') === 0 || raw.indexOf('blob:') === 0) continue;
            let target;
            try {
                // 相对路径要相对终端页面解析（css/style.css → /rms/css/style.css）
                target = new URL(raw, pageUrl);
            } catch (e) {
                continue;
            }
            if (target.origin === self.location.origin) {
                const p = target.pathname;
                if (p.indexOf('/rms/') !== 0 && p.indexOf('/platform/') !== 0) continue;
                urls.add(p + target.search);
            } else if (CDN_HOSTS.indexOf(target.hostname) !== -1) {
                urls.add(target.href);
            }
        }

        await Promise.all(
            Array.from(urls).map((u) => shell.add(new Request(u, { cache: 'reload' })).catch(() => {}))
        );
    } catch (e) {
        /* 安装时未登录/离线：忽略，之后打开终端会由运行时缓存补上 */
    }
}

/* ---------------- 静态资源 ---------------- */

async function staleWhileRevalidate(req, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);

    const network = fetch(req)
        .then((resp) => {
            if (resp && (resp.ok || resp.type === 'opaque')) {
                cache.put(req, resp.clone()).catch(() => {});
            }
            return resp;
        })
        .catch(() => null);

    if (cached) return cached;

    const fresh = await network;
    if (fresh) return fresh;

    return new Response('', { status: 504, statusText: 'Offline' });
}
