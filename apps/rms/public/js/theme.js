/**
 * RMS 全局亮/暗主题
 * localStorage.rms_theme = light | dark
 * 未设置时用 <html data-theme-default="light|dark">
 */
(function () {
    if (window.__RMS_THEME__) return;
    window.__RMS_THEME__ = true;

    var KEY = 'rms_theme';

    function pageDefault() {
        var d = document.documentElement.getAttribute('data-theme-default');
        return d === 'light' ? 'light' : 'dark';
    }

    function readTheme() {
        try {
            var t = localStorage.getItem(KEY);
            if (t === 'light' || t === 'dark') return t;
        } catch (e) { /* ignore */ }
        return pageDefault();
    }

    function applyTheme(theme) {
        var t = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', t);
        document.documentElement.classList.add('rms-themed');
        if (document.body) {
            document.body.setAttribute('data-theme', t);
        }
        document.querySelectorAll('[data-rms-theme-toggle]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
            btn.title = t === 'dark' ? '切换为亮色' : '切换为暗色';
            var label = btn.querySelector('[data-rms-theme-label]');
            if (label) label.textContent = t === 'dark' ? '暗色' : '亮色';
        });
    }

    function saveTheme(theme) {
        try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
    }

    function toggleTheme() {
        var next = readTheme() === 'dark' ? 'light' : 'dark';
        saveTheme(next);
        applyTheme(next);
    }

    function ensureToggle() {
        if (document.getElementById('rms-theme-toggle')) return;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'rms-theme-toggle';
        btn.className = 'rms-theme-toggle';
        btn.setAttribute('data-rms-theme-toggle', '1');
        btn.innerHTML = '<span class="rms-theme-toggle-ico" aria-hidden="true"></span><span data-rms-theme-label>主题</span>';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleTheme();
        });

        var slot = document.querySelector('[data-rms-theme-slot]');
        if (slot) {
            slot.appendChild(btn);
            return;
        }

        // 插到账号按钮前
        var userBtn = document.getElementById('username-btn');
        if (userBtn && userBtn.parentElement) {
            var wrap = document.createElement('div');
            wrap.className = 'rms-theme-toggle-wrap';
            wrap.setAttribute('data-rms-theme-slot', '1');
            wrap.appendChild(btn);
            userBtn.parentElement.insertBefore(wrap, userBtn);
            return;
        }

        document.body.appendChild(btn);
    }

    function boot() {
        applyTheme(readTheme());
        ensureToggle();
        applyTheme(readTheme());
    }

    // 尽早应用，减少闪烁（HTML 头里也应有内联脚本）
    applyTheme(readTheme());

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.RmsTheme = {
        get: readTheme,
        set: function (t) { saveTheme(t); applyTheme(t); },
        toggle: toggleTheme
    };
})();
