const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { query } = require('./lib/db');
const { ensureCsrf, verifyCsrf, verifyPassword, hashPassword, passwordMeetsPolicy, passwordPolicyMessage, formatDateInput } = require('./lib/helpers');
const { CERT_DIR, AVATAR_DIR, processAndSaveCertificate, processAndSaveAvatar, deleteCertificateFile, deleteAvatarFile, publicAvatarUrl } = require('./lib/upload');
const { requireLogin, requireAdmin } = require('./middleware/auth');
const { setUnifiedSession, ensureUnifiedSession } = require('../_shared/session');
const authTokens = require('../_shared/authTokens');
const rateLimit = require('../_shared/rateLimit');
const { getBranding, getBrandingAsync, loadSettings, getCategoryDefs, ensureReady, getAgencyListFromSettings, getNavItemsFromSettings, DEFAULT_NAV_ITEMS } = require('../_shared/systemSettings');
const { writeProfileLog } = require('./lib/orgLog');
const { pool } = require('./lib/db');
const idCards = require('./lib/idCards');
const qrLocal = require('./lib/qrLocal');

function actorFromReq(req) {
    const user = ensureUnifiedSession(req);
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    const ip = xf ? String(xf).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || null;
    return {
        actorUserId: user && user.id != null ? user.id : null,
        actorUsername: user && user.username ? user.username : null,
        ip
    };
}

function createApp() {
const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase();
        const name = String(file.originalname || '').toLowerCase();
        const okMime = mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png';
        const okExt = /\.(jpe?g|png)$/i.test(name);
        // 扩展名或 MIME 其一符合即可进入；最终以文件头校验为准
        if (okMime || okExt) return cb(null, true);
        cb(new Error('仅允许上传 JPG 或 PNG 图片'));
    }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Session 由统一入口注入，这里不再单独建 Session

app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.use(async (req, res, next) => {
    try {
        res.locals.branding = await getBrandingAsync();
    } catch (err) {
        res.locals.branding = getBranding();
    }
    next();
});

// 启动时预热 settings（不阻塞挂载）
ensureReady().catch(() => {});

async function agenciesForPage() {
    try {
        return getAgencyListFromSettings(await loadSettings());
    } catch (_) {
        return [];
    }
}

function currentUser(req) {
    const user = ensureUnifiedSession(req);
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        role: user.role
    };
}

function flashMsg(reqQuery) {
    if (reqQuery.msg === 'deleted') return '✔ 资质及原图已彻底删除！';
    if (reqQuery.msg === 'vol_deleted') return '✔ 队员档案及所有关联数据、证书图片已全部连带销毁！';
    if (reqQuery.msg === 'cert_updated') return '✔ 资质信息（及图片）修改成功！';
    if (reqQuery.msg === 'base_updated') return '✔ 基础信息已保存！';
    if (reqQuery.msg === 'id_card_added') return '✔ 证件已添加。';
    if (reqQuery.msg === 'id_card_saved') return '✔ 证件已保存（绑定/备注已更新）。';
    if (reqQuery.msg === 'id_card_lost') return '✔ 已挂失。扫码将只显示证件号与挂失提示。';
    if (reqQuery.msg === 'id_card_restored') return '✔ 已解除挂失。';
    if (reqQuery.msg === 'id_card_deleted') return '✔ 证件已删除。';
    return '';
}

function cardScanPayload(cardNo, branding) {
    const base = branding && branding.id_card_scan_base;
    return qrLocal.scanTarget(cardNo, base);
}

function exposeCardErr(err) {
    if (err && err.expose) return err.message;
    return '';
}

function safeRedirectTarget(raw) {
    if (!raw || typeof raw !== 'string') return '/dashboard.php';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard.php';
    return raw;
}

// 首页
app.get(['/', '/index.php'], (req, res) => {
    if (ensureUnifiedSession(req)) return res.redirect('/dashboard.php');
    return res.redirect('/login.php');
});

// 登录
app.get('/login.php', (req, res) => {
    if (ensureUnifiedSession(req)) {
        return res.redirect(safeRedirectTarget(req.query.redirect));
    }
    res.render('login', { user: null, error: '', redirect: req.query.redirect || '' });
});

app.post('/login.php', async (req, res) => {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const redirect = safeRedirectTarget(req.body.redirect || req.query.redirect);
    const gate = rateLimit.loginGate(req, username);
    if (!gate.ok) {
        return res.status(429).render('login', {
            user: null,
            error: '尝试次数过多，请 ' + gate.retryAfter + ' 秒后再试。',
            redirect
        });
    }
    try {
        const rows = await query('SELECT id, password_hash, role, volunteer_id FROM users WHERE username = ?', [username]);
        if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) {
            rateLimit.loginFail(req, username);
            return res.render('login', { user: null, error: '用户名或密码不正确。', redirect });
        }
        req.session.regenerate((err) => {
            if (err) return res.status(500).send('会话创建失败');
            const user = {
                id: rows[0].id,
                username,
                role: rows[0].role,
                volunteer_id: rows[0].volunteer_id || null
            };
            setUnifiedSession(req, user);
            authTokens.issueForUser(req, res, user);
            rateLimit.loginOk(req, username);
            res.redirect(redirect || '/dashboard.php');
        });
    } catch (err) {
        console.error(err);
        res.render('login', { user: null, error: '服务器内部错误，请稍后重试。', redirect });
    }
});

function finishLogout(req, res) {
    authTokens.logoutTokens(req, res);
    const done = () => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.redirect('/login.php');
    };
    if (!req.session) return done();
    req.session.destroy(done);
}

app.post('/logout.php', (req, res) => {
    finishLogout(req, res);
});

app.get('/logout.php', (req, res) => {
    if (authTokens.isCrossSiteGet(req)) {
        res.set('Cache-Control', 'no-store');
        return res.status(400).send(
            '<!DOCTYPE html><meta charset="utf-8"><title>退出</title>'
            + '<p>请确认退出登录。</p>'
            + '<form method="POST" action="/logout.php"><button type="submit">确认退出</button></form>'
        );
    }
    finishLogout(req, res);
});

// 导航页
app.get('/dashboard.php', requireLogin, async (req, res) => {
    let navItems = [];
    try {
        navItems = getNavItemsFromSettings(await loadSettings());
    } catch (_) {
        navItems = getNavItemsFromSettings(null);
    }
    const user = currentUser(req);
    let welcomeName = (user && user.username) ? user.username : '';
    const vid = req.session && req.session.volunteer_id;
    if (vid) {
        try {
            const vn = await query('SELECT name FROM volunteers WHERE id = ? LIMIT 1', [vid]);
            const nm = vn[0] && String(vn[0].name || '').trim();
            if (nm) welcomeName = nm;
        } catch (_) { /* ignore */ }
    }
    res.render('dashboard', { user, navItems, welcomeName });
});

// 系统设置（仅管理员）
app.get('/system_settings.php', requireAdmin, async (req, res) => {
    const settings = await loadSettings();
    res.render('system_settings', {
        user: currentUser(req),
        settings,
        categories: getCategoryDefs(),
        navItems: getNavItemsFromSettings(settings),
        defaultNavItems: DEFAULT_NAV_ITEMS
    });
});

// 改密
app.get('/form_pass.php', requireLogin, (req, res) => {
    res.render('form_pass', { user: currentUser(req), csrf: ensureCsrf(req), message: '', error: '' });
});

app.post('/form_pass.php', requireLogin, async (req, res) => {
    const csrf = ensureCsrf(req);
    if (!verifyCsrf(req)) {
        return res.status(403).render('form_pass', {
            user: currentUser(req),
            csrf,
            message: '',
            error: '安全校验失败，请刷新页面后重试。'
        });
    }
    const { old_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) {
        return res.render('form_pass', { user: currentUser(req), csrf, message: '', error: '两次新密码输入不一致。' });
    }
    if (!passwordMeetsPolicy(new_password)) {
        return res.render('form_pass', { user: currentUser(req), csrf, message: '', error: passwordPolicyMessage() });
    }
    try {
        const rows = await query('SELECT password_hash FROM users WHERE id = ?', [req.session.user_id]);
        if (!rows.length) {
            return res.render('form_pass', { user: currentUser(req), csrf, message: '', error: '系统未能读取到您的账号状态。' });
        }
        if (!(await verifyPassword(old_password, rows[0].password_hash))) {
            return res.render('form_pass', { user: currentUser(req), csrf, message: '', error: '旧密码验证失败，请确认您输入了正确的当前密码。' });
        }
        const newHash = await hashPassword(new_password);
        await query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.session.user_id]);
        authTokens.logoutTokens(req, res);
        const pageUser = currentUser(req);
        req.session.destroy(() => {
            res.set('Refresh', '2; url=/login.php');
            res.render('form_pass', {
                user: pageUser,
                csrf: '',
                message: '密码修改成功！为了安全，系统将在 2 秒后带您重新登录。',
                error: ''
            });
        });
    } catch (err) {
        console.error(err);
        res.render('form_pass', { user: currentUser(req), csrf, message: '', error: '数据库更新失败，请稍后再试。' });
    }
});

// 档案检索
app.get('/search.php', async (req, res) => {
    const q = (req.query.query || '').trim();
    let volunteer = null;
    let certsIn = [];
    let certsOut = [];
    let avatarUrl = '';

    if (q) {
        const lim = rateLimit.searchGet.hit('ip:' + rateLimit.clientIp(req));
        if (!lim.ok) {
            return res.status(429).render('search', {
                user: currentUser(req),
                q,
                volunteer: null,
                certsIn: [],
                certsOut: [],
                avatarUrl: '',
                error: '查询过于频繁，请稍后再试。'
            });
        }
        const rows = await query(
            'SELECT id, name, badge_number, blood_type, join_date, status, avatar_url FROM volunteers WHERE name LIKE ? OR badge_number = ? LIMIT 1',
            [`%${q}%`, q]
        );
        volunteer = rows[0] || null;
        if (volunteer) {
            volunteer = {
                ...volunteer,
                join_date: formatDateInput(volunteer.join_date)
            };
            certsIn = (await query(
                'SELECT * FROM certs_internal WHERE volunteer_id = ? ORDER BY issue_date DESC',
                [volunteer.id]
            )).map((c) => ({ ...c, issue_date: formatDateInput(c.issue_date) }));
            certsOut = (await query(
                'SELECT * FROM certs_external WHERE volunteer_id = ? ORDER BY expiry_date DESC',
                [volunteer.id]
            )).map((c) => ({
                ...c,
                issue_date: formatDateInput(c.issue_date),
                expiry_date: formatDateInput(c.expiry_date)
            }));
            avatarUrl = publicAvatarUrl(volunteer.avatar_url);
        }
    }

    res.render('search', {
        user: currentUser(req),
        q,
        volunteer,
        certsIn,
        certsOut,
        avatarUrl
    });
});

// 实体证件扫码
app.get('/id_card.php', async (req, res) => {
    const no = String(req.query.no || '').trim();
    const lim = rateLimit.searchGet.hit('ip:' + rateLimit.clientIp(req) + ':card');
    if (!lim.ok) {
        return res.status(429).render('id_card', {
            user: currentUser(req),
            view: 'error',
            cardNo: no,
            message: '查询过于频繁，请稍后再试。',
            volunteer: null,
            certsIn: [],
            certsOut: [],
            avatarUrl: '',
            profileQuery: ''
        });
    }

    let view = 'missing';
    let cardNo = no;
    let message = no ? '未找到该证件。' : '请扫描证件上的二维码。';
    let volunteer = null;
    let certsIn = [];
    let certsOut = [];
    let avatarUrl = '';
    let profileQuery = '';

    if (no) {
        const row = await idCards.getByCardNo(no);
        if (row) {
            cardNo = row.card_no;
            if (row.status === 'lost') {
                view = 'lost';
                message = '该证件已挂失。如拾获请交还组织，不要使用。';
            } else if (row.status === 'unbound' || !row.vol_id) {
                view = 'unbound';
                message = '该证件尚未绑定队员。';
            } else {
                const jump = String(row.badge_number || row.name || '').trim();
                if (jump) {
                    return res.redirect('/search.php?query=' + encodeURIComponent(jump));
                }
                view = 'unbound';
                message = '该证件尚未绑定队员。';
            }
        }
    }

    res.render('id_card', {
        user: currentUser(req),
        view,
        cardNo,
        message,
        volunteer,
        certsIn,
        certsOut,
        avatarUrl,
        profileQuery
    });
});

// 证件二维码图（本机生成，不走外网脚本）
app.get('/id_card_qr.php', requireAdmin, async (req, res) => {
    const no = String(req.query.no || '').trim();
    if (!no || no.length > 64 || /[<>"'&\s]/.test(no)) {
        return res.status(400).end();
    }
    const lim = rateLimit.searchGet.hit('ip:' + rateLimit.clientIp(req) + ':qr');
    if (!lim.ok) return res.status(429).end();
    try {
        const branding = await getBrandingAsync();
        const url = cardScanPayload(no, branding);
        const svg = qrLocal.toSvg(url, { width: 360 });
        res.setHeader('Cache-Control', 'private, max-age=120');
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.send(svg);
    } catch (err) {
        console.error('[id_card_qr]', err && err.message);
        res.status(500).end();
    }
});

// 证书图片
app.get('/get_cert.php', (req, res) => {
    const lim = rateLimit.certGet.hit('ip:' + rateLimit.clientIp(req));
    if (!lim.ok) return res.status(429).end();
    const filename = path.basename(req.query.file || '');
    const filePath = path.join(CERT_DIR, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(CERT_DIR)) || !fs.existsSync(resolved)) {
        return res.status(404).end();
    }
    const ext = path.extname(resolved).toLowerCase().replace('.', '');
    if (!['jpg', 'jpeg', 'png'].includes(ext)) {
        return res.status(403).end();
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(resolved);
});

// 头像图片（本地 avatars 目录）
app.get('/get_avatar.php', (req, res) => {
    const lim = rateLimit.certGet.hit('ip:' + rateLimit.clientIp(req) + ':av');
    if (!lim.ok) return res.status(429).end();
    const filename = path.basename(req.query.file || '');
    const filePath = path.join(AVATAR_DIR, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(AVATAR_DIR)) || !fs.existsSync(resolved)) {
        return res.status(404).end();
    }
    const ext = path.extname(resolved).toLowerCase().replace('.', '');
    if (!['jpg', 'jpeg', 'png'].includes(ext)) {
        return res.status(403).end();
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(resolved);
});

app.get('/view_cert.php', (req, res) => {
    res.redirect(`/get_cert.php?file=${encodeURIComponent(req.query.file || '')}`);
});

function getUploadedFile(req, field) {
    if (req.files && req.files[field] && req.files[field][0]) return req.files[field][0];
    return null;
}

// 证书/头像 multipart；普通表单不挂 multer
function optionalImageUpload(req, res, next) {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) {
        return upload.fields([
            { name: 'cert_image', maxCount: 1 },
            { name: 'avatar_image', maxCount: 1 }
        ])(req, res, (err) => {
            if (err) {
                const msg = err.code === 'LIMIT_FILE_SIZE'
                    ? '上传失败：文件不能超过 8MB。'
                    : ('上传失败：' + (err.message || '仅允许 JPG / PNG。'));
                return res.status(400).send('❌ ' + msg);
            }
            return next();
        });
    }
    return next();
}

// 管理后台
app.all('/admin_edit.php', requireAdmin, optionalImageUpload, async (req, res) => {
    const csrf = ensureCsrf(req);
    let msg = flashMsg(req.query);
    let listTab = String(req.query.tab || '') === 'cards' ? 'cards' : 'people';

    try {
        if (req.method === 'POST') {
            if (!verifyCsrf(req)) {
                return res.status(403).send('❌ 安全警告：CSRF 验证失败，请求非法。');
            }
            const body = req.body || {};
            if (
                body.add_id_card !== undefined
                || body.save_id_card !== undefined
                || body.lose_id_card !== undefined
                || body.restore_id_card !== undefined
                || body.delete_id_card !== undefined
            ) {
                listTab = 'cards';
            }

            if (body.add_volunteer !== undefined) {
                await query(
                    "INSERT INTO volunteers (name, badge_number, status, join_date) VALUES (?, ?, 'active', ?)",
                    [body.new_name, body.new_badge, body.new_join_date]
                );
                msg = '新队员档案初始化成功！';
            }

            if (body.add_id_card !== undefined) {
                try {
                    const newId = await idCards.createCard({
                        cardNo: body.new_card_no,
                        note: body.new_card_note,
                        volunteerId: body.new_card_vid
                    });
                    writeProfileLog(pool, {
                        ...actorFromReq(req),
                        action: 'add_id_card',
                        volunteerId: parseInt(body.new_card_vid, 10) || 0,
                        entityType: 'id_card',
                        entityId: newId,
                        summary: `新增证件：${String(body.new_card_no || '').trim()}`,
                        after: {
                            card_no: String(body.new_card_no || '').trim(),
                            note: String(body.new_card_note || '').trim(),
                            volunteer_id: body.new_card_vid || null
                        }
                    });
                    return res.redirect('/admin_edit.php?tab=cards&msg=id_card_added');
                } catch (err) {
                    msg = '❌ ' + (exposeCardErr(err) || '添加证件失败。');
                }
            }

            if (body.save_id_card !== undefined) {
                try {
                    await idCards.saveCard({
                        id: body.card_id,
                        note: body.card_note,
                        volunteerId: body.card_vid
                    });
                    writeProfileLog(pool, {
                        ...actorFromReq(req),
                        action: 'save_id_card',
                        volunteerId: parseInt(body.card_vid, 10) || 0,
                        entityType: 'id_card',
                        entityId: parseInt(body.card_id, 10) || null,
                        summary: `保存证件绑定/备注`,
                        after: {
                            note: String(body.card_note || '').trim(),
                            volunteer_id: body.card_vid || null
                        }
                    });
                    return res.redirect('/admin_edit.php?tab=cards&msg=id_card_saved');
                } catch (err) {
                    msg = '❌ ' + (exposeCardErr(err) || '保存证件失败。');
                }
            }

            if (body.lose_id_card !== undefined) {
                try {
                    const card = await idCards.loseCard(body.card_id);
                    writeProfileLog(pool, {
                        ...actorFromReq(req),
                        action: 'lose_id_card',
                        volunteerId: card.volunteer_id || 0,
                        entityType: 'id_card',
                        entityId: card.id,
                        summary: `挂失证件：${card.card_no}`
                    });
                    return res.redirect('/admin_edit.php?tab=cards&msg=id_card_lost');
                } catch (err) {
                    msg = '❌ ' + (exposeCardErr(err) || '挂失失败。');
                }
            }

            if (body.restore_id_card !== undefined) {
                try {
                    const card = await idCards.restoreCard(body.card_id);
                    writeProfileLog(pool, {
                        ...actorFromReq(req),
                        action: 'restore_id_card',
                        volunteerId: card.volunteer_id || 0,
                        entityType: 'id_card',
                        entityId: card.id,
                        summary: `解除挂失：${card.card_no}`
                    });
                    return res.redirect('/admin_edit.php?tab=cards&msg=id_card_restored');
                } catch (err) {
                    msg = '❌ ' + (exposeCardErr(err) || '解除挂失失败。');
                }
            }

            if (body.delete_id_card !== undefined) {
                try {
                    const card = await idCards.deleteCard(body.card_id);
                    writeProfileLog(pool, {
                        ...actorFromReq(req),
                        action: 'delete_id_card',
                        volunteerId: card.volunteer_id || 0,
                        entityType: 'id_card',
                        entityId: card.id,
                        summary: `删除证件：${card.card_no}`
                    });
                    return res.redirect('/admin_edit.php?tab=cards&msg=id_card_deleted');
                } catch (err) {
                    msg = '❌ ' + (exposeCardErr(err) || '删除证件失败。');
                }
            }

            // 兼容：按钮名 / 隐藏域 / 带 phone 的基础信息表单
            const isUpdateBase = body.update_base !== undefined || (
                body.vid != null
                && body.phone !== undefined
                && body.status !== undefined
                && body.add_cert === undefined
                && body.add_volunteer === undefined
                && body.create_account === undefined
                && body.update_account === undefined
                && body.update_cert_info === undefined
                && body.add_id_card === undefined
                && body.save_id_card === undefined
                && body.lose_id_card === undefined
                && body.restore_id_card === undefined
                && body.delete_id_card === undefined
            );

            if (isUpdateBase) {
                const vid = parseInt(body.vid, 10);
                const phone = String(body.phone || '').trim();
                if (!vid) {
                    return res.status(400).send('保存失败：缺少队员 ID');
                }

                const phoneCols = await query("SHOW COLUMNS FROM volunteers LIKE 'phone'");
                if (!phoneCols.length) {
                    return res.status(500).send(
                        '保存失败：当前数据库 volunteers 表没有 phone 字段。<br>'
                        + '请在<strong>正在连接的那台 MySQL</strong>执行：<br>'
                        + '<code>ALTER TABLE volunteers ADD COLUMN phone VARCHAR(20) NULL COMMENT \'企业微信绑定手机号\' AFTER blood_type;</code>'
                    );
                }

                const agencyCols = await query("SHOW COLUMNS FROM volunteers LIKE 'agency'");
                if (!agencyCols.length) {
                    return res.status(500).send(
                        '保存失败：当前数据库 volunteers 表没有 agency 字段。<br>'
                        + '请执行：<br>'
                        + '<code>ALTER TABLE volunteers ADD COLUMN agency VARCHAR(64) NOT NULL DEFAULT \'\' COMMENT \'分区/Agency名称\';</code>'
                    );
                }

                const existing = await query('SELECT id, name, badge_number, avatar_url, agency FROM volunteers WHERE id=?', [vid]);
                if (!existing.length) {
                    return res.status(404).send('保存失败：未找到该队员 id=' + vid);
                }

                let avatarStored = existing[0].avatar_url || null;
                const avatarFile = getUploadedFile(req, 'avatar_image');
                if (avatarFile) {
                    const newAvatar = await processAndSaveAvatar(avatarFile, {
                        badgeNumber: existing[0].badge_number,
                        personName: existing[0].name
                    });
                    if (newAvatar) {
                        deleteAvatarFile(existing[0].avatar_url);
                        avatarStored = newAvatar;
                    }
                }

                const allowedAgencies = await agenciesForPage();
                let agency = String(body.agency || '').trim();
                const prevAgency = String(existing[0].agency || '').trim();
                if (
                    agency
                    && allowedAgencies.length
                    && !allowedAgencies.includes(agency)
                    && agency !== prevAgency
                ) {
                    return res.status(400).send('保存失败：分区不在系统设置列表中，请先到「系统设置 → RMS → Agency / 分区」添加。');
                }

                await query(
                    'UPDATE volunteers SET blood_type=?, avatar_url=?, status=?, join_date=?, phone=?, agency=? WHERE id=?',
                    [body.blood_type || null, avatarStored, body.status, body.join_date || null, phone || null, agency, vid]
                );
                const check = await query('SELECT id, phone, agency FROM volunteers WHERE id=?', [vid]);
                console.log('[admin_edit] update_base', {
                    vid,
                    phone,
                    agency,
                    avatar: avatarStored,
                    dbPhone: check[0] ? check[0].phone : null,
                    dbAgency: check[0] ? check[0].agency : null,
                    bodyKeys: Object.keys(body)
                });
                writeProfileLog(pool, {
                    ...actorFromReq(req),
                    action: 'update_volunteer',
                    volunteerId: vid,
                    volunteerName: existing[0].name,
                    entityType: 'volunteer',
                    entityId: vid,
                    summary: `更新队员档案：${existing[0].name}`,
                    before: {
                        phone: existing[0].phone,
                        agency: existing[0].agency,
                        avatar_url: existing[0].avatar_url,
                        status: existing[0].status
                    },
                    after: {
                        phone: phone || null,
                        agency,
                        avatar_url: avatarStored,
                        status: body.status,
                        blood_type: body.blood_type || null,
                        join_date: body.join_date || null
                    }
                });
                return res.redirect(`/admin_edit.php?edit_id=${vid}&msg=base_updated`);
            }

            if (body.add_cert !== undefined) {
                let imageName = body.image_url_fallback || '';
                const certFile = getUploadedFile(req, 'cert_image');
                if (certFile) {
                    const volRows = await query('SELECT badge_number FROM volunteers WHERE id=?', [body.vid]);
                    const badgeNumber = volRows[0] ? volRows[0].badge_number : '';
                    imageName = await processAndSaveCertificate(certFile, {
                        badgeNumber,
                        certName: body.cert_name
                    });
                }
                const showOnDispatch = body.show_on_dispatch === '1' || body.show_on_dispatch === 'on' ? 1 : 0;
                if (body.type === 'internal') {
                    await query(
                        'INSERT INTO certs_internal (volunteer_id, cert_name, issue_date, image_url, show_on_dispatch) VALUES (?, ?, ?, ?, ?)',
                        [body.vid, body.cert_name, body.issue_date, imageName, showOnDispatch]
                    );
                } else {
                    await query(
                        'INSERT INTO certs_external (volunteer_id, cert_name, issue_date, expiry_date, image_url, show_on_dispatch) VALUES (?, ?, ?, ?, ?, ?)',
                        [body.vid, body.cert_name, body.issue_date, body.expiry_date, imageName, showOnDispatch]
                    );
                }
                const volNameRows = await query('SELECT name FROM volunteers WHERE id=?', [body.vid]);
                writeProfileLog(pool, {
                    ...actorFromReq(req),
                    action: 'add_cert',
                    volunteerId: parseInt(body.vid, 10),
                    volunteerName: volNameRows[0] ? volNameRows[0].name : null,
                    entityType: body.type === 'internal' ? 'cert_internal' : 'cert_external',
                    summary: `新增资质：${body.cert_name}`,
                    after: {
                        cert_name: body.cert_name,
                        type: body.type,
                        issue_date: body.issue_date,
                        expiry_date: body.expiry_date || null,
                        show_on_dispatch: showOnDispatch
                    }
                });
                msg = '资质与附件已安全存档！';
            }

            if (body.create_account !== undefined) {
                const exists = await query('SELECT id FROM users WHERE username=?', [body.username]);
                if (exists.length) {
                    msg = '❌ 账号创建失败：登录名已存在。';
                } else if (!passwordMeetsPolicy(body.password)) {
                    msg = '❌ 账号创建失败：' + passwordPolicyMessage();
                } else {
                    const hash = await hashPassword(body.password);
                    await query(
                        'INSERT INTO users (username, password_hash, role, volunteer_id) VALUES (?, ?, ?, ?)',
                        [body.username, hash, body.role, body.vid]
                    );
                    msg = '✅ 系统账号分配成功！';
                }
            }

            if (body.update_account !== undefined) {
                const uid = parseInt(body.uid, 10);
                const exists = await query('SELECT id FROM users WHERE username=? AND id != ?', [body.username, uid]);
                if (exists.length) {
                    msg = '❌ 更新失败：该登录名已被占用。';
                } else if (body.new_password && !passwordMeetsPolicy(body.new_password)) {
                    msg = '❌ 更新失败：' + passwordPolicyMessage();
                } else if (body.new_password) {
                    const hash = await hashPassword(body.new_password);
                    await query(
                        'UPDATE users SET username=?, role=?, password_hash=? WHERE id=?',
                        [body.username, body.role, hash, uid]
                    );
                    msg = '✅ 账号信息已更新！';
                } else {
                    await query(
                        'UPDATE users SET username=?, role=? WHERE id=?',
                        [body.username, body.role, uid]
                    );
                    msg = '✅ 账号信息已更新！';
                }
            }

            if (body.update_cert_info !== undefined) {
                const table = body.type === 'internal' ? 'certs_internal' : 'certs_external';
                const showOnDispatch = body.show_on_dispatch === '1' || body.show_on_dispatch === 'on' ? 1 : 0;
                if (body.type === 'external') {
                    await query(
                        `UPDATE ${table} SET cert_name=?, issue_date=?, expiry_date=?, show_on_dispatch=? WHERE id=?`,
                        [body.cert_name, body.issue_date, body.expiry_date, showOnDispatch, body.cert_id]
                    );
                } else {
                    await query(
                        `UPDATE ${table} SET cert_name=?, issue_date=?, show_on_dispatch=? WHERE id=?`,
                        [body.cert_name, body.issue_date, showOnDispatch, body.cert_id]
                    );
                }
                if (getUploadedFile(req, 'cert_image')) {
                    const oldRows = await query(`SELECT image_url FROM ${table} WHERE id=?`, [body.cert_id]);
                    if (oldRows[0]) deleteCertificateFile(oldRows[0].image_url);
                    const volRows = await query('SELECT badge_number FROM volunteers WHERE id=?', [body.vid]);
                    const badgeNumber = volRows[0] ? volRows[0].badge_number : '';
                    const newImg = await processAndSaveCertificate(getUploadedFile(req, 'cert_image'), {
                        badgeNumber,
                        certName: body.cert_name
                    });
                    if (newImg) {
                        await query(`UPDATE ${table} SET image_url=? WHERE id=?`, [newImg, body.cert_id]);
                    }
                }
                return res.redirect(`?edit_id=${body.vid}&msg=cert_updated`);
            }

            if (body.del_cert !== undefined) {
                const table = body.type === 'internal' ? 'certs_internal' : 'certs_external';
                const certId = body.del_cert;
                const rows = await query(`SELECT image_url FROM ${table} WHERE id=?`, [certId]);
                if (rows[0]) deleteCertificateFile(rows[0].image_url);
                await query(`DELETE FROM ${table} WHERE id=?`, [certId]);
                return res.redirect(`?edit_id=${body.vid}&msg=deleted`);
            }

            if (body.delete_volunteer !== undefined) {
                const vid = parseInt(body.vid, 10);
                if (!vid) return res.status(400).send('缺少队员 ID');
                const volRows = await query('SELECT avatar_url FROM volunteers WHERE id=?', [vid]);
                for (const tbl of ['certs_internal', 'certs_external']) {
                    const imgs = await query(`SELECT image_url FROM ${tbl} WHERE volunteer_id=?`, [vid]);
                    imgs.forEach((r) => deleteCertificateFile(r.image_url));
                    await query(`DELETE FROM ${tbl} WHERE volunteer_id=?`, [vid]);
                }
                await query('DELETE FROM users WHERE volunteer_id=?', [vid]);
                await idCards.unbindCardsOfDeletedVolunteer(vid);
                await query('DELETE FROM volunteers WHERE id=?', [vid]);
                if (volRows[0]) deleteAvatarFile(volRows[0].avatar_url);
                return res.redirect('/admin_edit.php?tab=people&msg=vol_deleted');
            }
        }

        // 页面渲染
        if (req.query.edit_id) {
            const vid = parseInt(req.query.edit_id, 10);
            const vols = await query('SELECT * FROM volunteers WHERE id=?', [vid]);
            if (!vols.length) return res.status(404).send('未找到该队员！');
            const vol = {
                ...vols[0],
                join_date: formatDateInput(vols[0].join_date),
                phone: vols[0].phone != null ? String(vols[0].phone) : '',
                agency: vols[0].agency != null ? String(vols[0].agency) : ''
            };
            const internal = await query('SELECT * FROM certs_internal WHERE volunteer_id=?', [vid]);
            const external = await query('SELECT * FROM certs_external WHERE volunteer_id=?', [vid]);
            const certs = [
                ...internal.map((c) => ({
                    ...c,
                    issue_date: formatDateInput(c.issue_date),
                    type: 'internal',
                    label: '[队内]',
                    color: '#0056b3',
                    dateInfo: `(${formatDateInput(c.issue_date)})`,
                    show_on_dispatch: Number(c.show_on_dispatch) === 1
                })),
                ...external.map((c) => ({
                    ...c,
                    issue_date: formatDateInput(c.issue_date),
                    expiry_date: formatDateInput(c.expiry_date),
                    type: 'external',
                    label: '[通用]',
                    color: '#28a745',
                    dateInfo: `(至 ${formatDateInput(c.expiry_date)})`,
                    show_on_dispatch: Number(c.show_on_dispatch) === 1
                }))
            ];
            return res.render('admin_edit', {
                user: currentUser(req),
                csrf,
                msg,
                mode: 'edit_vol',
                vol,
                certs,
                agencies: await agenciesForPage(),
                volunteers: [],
                idCards: [],
                cardPublicBase: '',
                cert: null,
                accountUser: null,
                vid,
                type: ''
            });
        }

        if (req.query.edit_cert_id) {
            const certId = parseInt(req.query.edit_cert_id, 10);
            const type = req.query.type;
            const table = type === 'internal' ? 'certs_internal' : 'certs_external';
            const rows = await query(`SELECT * FROM ${table} WHERE id=?`, [certId]);
            if (!rows.length) return res.status(404).send('未找到对应资质记录！');
            const cert = {
                ...rows[0],
                issue_date: formatDateInput(rows[0].issue_date),
                expiry_date: formatDateInput(rows[0].expiry_date),
                show_on_dispatch: Number(rows[0].show_on_dispatch) === 1
            };
            return res.render('admin_edit', {
                user: currentUser(req),
                csrf,
                msg,
                mode: 'edit_cert',
                cert,
                type,
                vid: req.query.vid,
                vol: null,
                certs: [],
                agencies: [],
                volunteers: [],
                idCards: [],
                cardPublicBase: '',
                accountUser: null
            });
        }

        if (req.query.account_id) {
            const vid = parseInt(req.query.account_id, 10);
            const vols = await query('SELECT id, name FROM volunteers WHERE id=?', [vid]);
            if (!vols.length) return res.status(404).send('未找到该队员！');
            const users = await query('SELECT * FROM users WHERE volunteer_id=?', [vid]);
            return res.render('admin_edit', {
                user: currentUser(req),
                csrf,
                msg,
                mode: 'account',
                vol: vols[0],
                accountUser: users[0] || null,
                certs: [],
                agencies: [],
                volunteers: [],
                idCards: [],
                cardPublicBase: '',
                cert: null,
                vid,
                type: ''
            });
        }

        const volunteers = await query('SELECT * FROM volunteers ORDER BY id DESC');
        let cards = [];
        try {
            cards = await idCards.listCards();
        } catch (err) {
            console.error('[id_cards]', err.message);
            if (!msg) msg = '❌ 无法读取证件表，请确认 org.id_cards 已创建。';
        }
        let scanBase = '';
        try {
            const branding = await getBrandingAsync();
            scanBase = branding && branding.id_card_scan_base;
        } catch (_) { /* ignore */ }
        cards = (cards || []).map((c) => {
            const scanUrl = cardScanPayload(c.card_no, { id_card_scan_base: scanBase });
            let qrDataUri = '';
            try {
                qrDataUri = qrLocal.toDataUri(scanUrl, { width: 240 });
            } catch (err) {
                console.error('[id_card_qr]', err && err.message);
            }
            return { ...c, scanUrl, qrDataUri };
        });
        return res.render('admin_edit', {
            user: currentUser(req),
            csrf,
            msg,
            mode: 'list',
            volunteers,
            idCards: cards,
            cardPublicBase: scanBase || '',
            cardScanBase: scanBase || '',
            listTab,
            agencies: await agenciesForPage(),
            vol: null,
            certs: [],
            cert: null,
            accountUser: null,
            vid: null,
            type: ''
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('服务器内部错误');
    }
});

return app;
}

module.exports = { createApp };
module.exports.createApp = createApp;
// 兼容：默认导出 app 工厂结果需由入口创建

