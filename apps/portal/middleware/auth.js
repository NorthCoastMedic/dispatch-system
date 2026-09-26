const { ensureUnifiedSession } = require('../../_shared/session');

function requireLogin(req, res, next) {
    if (!ensureUnifiedSession(req)) {
        return res.redirect('/login.php?redirect=' + encodeURIComponent(req.originalUrl || '/dashboard.php'));
    }
    next();
}

function requireAdmin(req, res, next) {
    const user = ensureUnifiedSession(req);
    if (!user) {
        return res.redirect('/login.php');
    }
    if (user.role !== 'admin') {
        return res.status(403).send(
            '<h1>403 禁止访问</h1><p>该功能仅限管理员使用。</p><a href="/dashboard.php">返回主页</a>'
        );
    }
    next();
}

module.exports = { requireLogin, requireAdmin };
