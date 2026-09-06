/**
 * 账号下拉菜单导航（替代悬浮球 / 顶栏芯片）
 * 在 #user-dropdown 上设 data-ptn="rms"，会在「退出登录」上方插入：
 *   工作台项（管理员可见指挥台/展示）+ 内部导航
 * 若页面仍有 #platform-topnav[data-ptn=modules]，仅渲染「内部导航」链接（RTLS/WBGT）
 */
(function () {
    if (window.__PLATFORM_TOPNAV__) return;
    window.__PLATFORM_TOPNAV__ = true;

    var path = window.location.pathname || '';

    var roles = [
        { href: '/rms/', label: '响应终端', page: 'responder' },
        { href: '/rms/dispatch.html', label: '调度指挥台', page: 'dispatch', admin: true },
        { href: '/rms/display.html', label: '状态展示', page: 'display', admin: true }
    ];

    function currentRmsPage() {
        if (/\/rms\/dispatch\.html$/i.test(path)) return 'dispatch';
        if (/\/rms\/display\.html$/i.test(path)) return 'display';
        if (/\/rms\/?(?:index\.html)?$/i.test(path)) return 'responder';
        return null;
    }

    function buildMenuHtml(admin) {
        var html = '<div class="ptn-menu-block" data-ptn-injected="1">';
        html += '<div class="ptn-menu-label">工作台</div>';
        roles.forEach(function (item) {
            if (item.admin && !admin) return;
            var active = item.page === currentRmsPage();
            html += '<a class="ptn-menu-item' + (active ? ' is-active' : '') + '" href="' + item.href + '"'
                + (active ? ' aria-current="page"' : '') + '>' + item.label
                + (active ? '<span class="ptn-menu-now">当前</span>' : '')
                + '</a>';
        });
        html += '<div class="ptn-menu-divider"></div>';
        html += '<a class="ptn-menu-item" href="/dashboard.php">内部导航</a>';
        html += '<div class="ptn-menu-divider"></div>';
        html += '</div>';
        return html;
    }

    function fillDropdown(dropdown, admin) {
        var old = dropdown.querySelector('[data-ptn-injected]');
        if (old) old.remove();
        var logout = dropdown.querySelector('#logout-btn');
        var block = document.createElement('div');
        block.innerHTML = buildMenuHtml(admin);
        var node = block.firstChild;
        if (logout) dropdown.insertBefore(node, logout);
        else dropdown.appendChild(node);
        dropdown.classList.add('ptn-dropdown');
    }

    function fillBar(root) {
        root.classList.add('ptn');
        root.innerHTML = '<a class="ptn-home nav-item nav-btn" href="/dashboard.php">内部导航</a>';
    }

    function boot() {
        var menus = document.querySelectorAll('#user-dropdown[data-ptn="rms"], #user-dropdown[data-ptn=rms]');
        var bars = document.querySelectorAll('#platform-topnav[data-ptn="modules"], #platform-topnav[data-ptn=modules]');

        menus.forEach(function (m) { fillDropdown(m, false); });
        bars.forEach(fillBar);

        if (!menus.length && !bars.length) return;

        fetch('/api/session', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var admin = !!(data && data.success && data.user && data.user.role === 'admin');
                menus.forEach(function (m) { fillDropdown(m, admin); });
            })
            .catch(function () { /* ignore */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
