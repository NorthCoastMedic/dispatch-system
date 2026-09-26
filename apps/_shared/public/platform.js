/**
 * 自动识别模块前缀（/rms /rtls /wbgt），改写模块内 /api 与 socket.io 请求
 * 全局接口（如 /api/session）不改写
 */
(function () {
    var m = location.pathname.match(/^\/(rms|rtls|wbgt)(?=\/|$)/);
    var base = m ? '/' + m[1] : '';

    /** 根入口提供的全局 API，禁止加模块前缀 */
    var GLOBAL_API = {
        '/api/session': true,
        '/api/system-settings': true,
        '/api/auth/refresh': true,
        '/api/auth/logout': true
    };

    function shouldRewriteApiPath(pathname) {
        if (!base) return false;
        if (GLOBAL_API[pathname]) return false;
        return pathname.indexOf('/api') === 0 || pathname.indexOf('/socket.io') === 0;
    }

    window.Platform = {
        base: base,
        module: m ? m[1] : 'portal',
        api: function (path) {
            if (!path) return path;
            if (shouldRewriteApiPath(path.split('?')[0])) {
                return base + path;
            }
            return path;
        },
        ioOptions: function () {
            return {
                path: base ? base + '/socket.io' : '/socket.io',
                withCredentials: true,
                transports: ['websocket', 'polling']
            };
        }
    };

    var rawFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        try {
            if (typeof input === 'string') {
                var u = new URL(input, location.origin);
                if (u.origin === location.origin && shouldRewriteApiPath(u.pathname)) {
                    u.pathname = base + u.pathname;
                    input = u.pathname + u.search + u.hash;
                    if (/^https?:/i.test(arguments[0])) input = u.toString();
                }
            }
        } catch (e) { /* ignore */ }
        return rawFetch(input, init);
    };
})();
