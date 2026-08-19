const session = require('express-session');

class MysqlSessionStore extends session.Store {
    constructor(pool) {
        super();
        this.pool = pool;
        this._pruneTimer = setInterval(() => this._prune(), 10 * 60 * 1000);
        if (this._pruneTimer.unref) this._pruneTimer.unref();
    }

    _prune() {
        const now = Math.floor(Date.now() / 1000);
        this.pool.query('DELETE FROM sessions WHERE expires < ?', [now]).catch(() => {});
    }

    get(sid, cb) {
        this.pool.query(
            'SELECT data, expires FROM sessions WHERE session_id = ? LIMIT 1',
            [sid]
        ).then(([rows]) => {
            if (!rows.length) return cb(null, null);
            const exp = Number(rows[0].expires) || 0;
            if (exp && exp < Math.floor(Date.now() / 1000)) {
                return this.destroy(sid, () => cb(null, null));
            }
            const raw = rows[0].data;
            if (!raw) return cb(null, null);
            try {
                cb(null, typeof raw === 'string' ? JSON.parse(raw) : raw);
            } catch (err) {
                cb(err);
            }
        }).catch(cb);
    }

    set(sid, sess, cb) {
        const maxAge = sess && sess.cookie && sess.cookie.maxAge
            ? Math.ceil(Number(sess.cookie.maxAge) / 1000)
            : 86400;
        const expires = Math.floor(Date.now() / 1000) + (Number.isFinite(maxAge) ? maxAge : 86400);
        const data = JSON.stringify(sess);
        this.pool.query(
            `INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
            [sid, expires, data]
        ).then(() => cb(null)).catch(cb);
    }

    destroy(sid, cb) {
        this.pool.query('DELETE FROM sessions WHERE session_id = ?', [sid])
            .then(() => cb && cb(null))
            .catch(cb);
    }

    touch(sid, sess, cb) {
        const maxAge = sess && sess.cookie && sess.cookie.maxAge
            ? Math.ceil(Number(sess.cookie.maxAge) / 1000)
            : 86400;
        const expires = Math.floor(Date.now() / 1000) + (Number.isFinite(maxAge) ? maxAge : 86400);
        this.pool.query('UPDATE sessions SET expires = ? WHERE session_id = ?', [expires, sid])
            .then(() => cb && cb(null))
            .catch(cb);
    }
}

module.exports = MysqlSessionStore;
