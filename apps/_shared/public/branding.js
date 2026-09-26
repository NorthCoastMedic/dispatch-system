/**
 * 读取 /api/system-settings，填充：
 * - [data-brand="字段名"] 文本（优先 branding，其次 rms）
 * - [data-brand-href="字段名"] 链接
 * - [data-brand-show="字段名"] 按 1/0 显示或隐藏
 * - [data-brand-title="字段名"] 同步 document.title
 */
(function () {
    function isOn(v) {
        var s = String(v == null ? '' : v).trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === '打开';
    }

    function flattenSettings(settings) {
        var out = {};
        if (!settings || typeof settings !== 'object') return out;
        ['branding', 'rms', 'nav'].forEach(function (cat) {
            var bag = settings[cat];
            if (!bag || typeof bag !== 'object') return;
            Object.keys(bag).forEach(function (k) {
                out[k] = bag[k];
            });
        });
        return out;
    }

    function applyBranding(branding) {
        if (!branding) return;
        document.querySelectorAll('[data-brand]').forEach(function (el) {
            var key = el.getAttribute('data-brand');
            if (!key || branding[key] == null) return;
            el.textContent = branding[key];
        });
        document.querySelectorAll('[data-brand-href]').forEach(function (el) {
            var key = el.getAttribute('data-brand-href');
            if (!key || !branding[key]) return;
            el.setAttribute('href', branding[key]);
        });
        document.querySelectorAll('[data-brand-show]').forEach(function (el) {
            var key = el.getAttribute('data-brand-show');
            if (!key) return;
            var show = isOn(branding[key]);
            el.classList.toggle('hidden', !show);
            el.style.display = show ? '' : 'none';
        });
        document.querySelectorAll('[data-brand-title]').forEach(function (el) {
            var key = el.getAttribute('data-brand-title');
            if (!key || branding[key] == null || branding[key] === '') return;
            document.title = String(branding[key]);
        });
    }

    function load() {
        fetch('/api/system-settings', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.success || !data.settings) return;
                var flat = flattenSettings(data.settings);
                applyBranding(flat);
                window.PlatformBranding = data.settings.branding || {};
                window.PlatformSettings = data.settings;
                try {
                    window.dispatchEvent(new CustomEvent('platform-branding', { detail: flat }));
                } catch (e) { /* ignore */ }
            })
            .catch(function () { /* ignore */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', load);
    } else {
        load();
    }
})();
