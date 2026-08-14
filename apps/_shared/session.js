/**
 * 统一会话（跨 portal / RMS / RTLS / WBGT）
 */

function ensureUnifiedSession(req) {
    if (!req) return null;
    if (req.auth && req.auth.sub) {
        const id = parseInt(req.auth.sub, 10);
        if (id) {
            const user = {
                id,
                username: req.auth.username,
                role: req.auth.role,
                volunteer_id: req.auth.volunteer_id || null
            };
            if (req.session) {
                req.session.user = user;
                req.session.user_id = user.id;
                req.session.username = user.username;
                req.session.role = user.role;
                req.session.volunteer_id = user.volunteer_id;
            }
            return user;
        }
    }
    if (!req.session) return null;
    if (req.session.user && req.session.user.id) {
        req.session.user_id = req.session.user.id;
        req.session.username = req.session.user.username;
        req.session.role = req.session.user.role;
        return req.session.user;
    }
    if (req.session.user_id) {
        req.session.user = {
            id: req.session.user_id,
            username: req.session.username,
            role: req.session.role,
            volunteer_id: req.session.volunteer_id || null
        };
        return req.session.user;
    }
    return null;
}

function setUnifiedSession(req, user) {
    req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        volunteer_id: user.volunteer_id || null
    };
    req.session.user_id = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.volunteer_id = user.volunteer_id || null;
}

function requireUnifiedLogin(req, res, next) {
    const user = ensureUnifiedSession(req);
    if (!user) {
        const nextUrl = encodeURIComponent(req.originalUrl || '/');
        return res.redirect('/login.php?redirect=' + nextUrl);
    }
    next();
}

function requireUnifiedAdmin(req, res, next) {
    const user = ensureUnifiedSession(req);
    if (!user) {
        const nextUrl = encodeURIComponent(req.originalUrl || '/');
        return res.redirect('/login.php?redirect=' + nextUrl);
    }
    if (user.role !== 'admin') {
        return res.status(403).json({ success: false, message: '需要管理员权限' });
    }
    next();
}

/** Express / Socket.IO 共用：从 req 或 socket.request 取用户 */
function getUserFromRequest(reqLike) {
    if (!reqLike) return null;
    return ensureUnifiedSession(reqLike);
}

function isAdminUser(user) {
    return !!(user && user.role === 'admin');
}

module.exports = {
    ensureUnifiedSession,
    setUnifiedSession,
    requireUnifiedLogin,
    requireUnifiedAdmin,
    getUserFromRequest,
    isAdminUser
};
