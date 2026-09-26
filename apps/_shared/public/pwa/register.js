/**
 * 注册 Service Worker（根作用域 /sw.js）
 * 仅在安全上下文（HTTPS 或 localhost）下注册；失败静默忽略，不影响页面功能。
 */
(function () {
    if (!('serviceWorker' in navigator)) return;

    var host = location.hostname;
    var secure = location.protocol === 'https:'
        || host === 'localhost'
        || host === '127.0.0.1'
        || host === '[::1]';
    if (!secure) return;

    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
            /* 注册失败（如隐私模式、证书不受信）时照常使用在线功能 */
        });
    });
})();
