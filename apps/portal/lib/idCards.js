/**
 * 实体证件卡：与 volunteers.id_card_no 同步。
 * 一人一卡；挂失保留绑定；可改回未绑定（不必另选一张卡）。
 */
const crypto = require('crypto');
const { pool } = require('./db');

class IdCardError extends Error {
    constructor(message) {
        super(message);
        this.expose = true;
        this.name = 'IdCardError';
    }
}

function normalizeCardNo(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) throw new IdCardError('请填写证件号。');
    if (s.length > 64) throw new IdCardError('证件号最长 64 个字符。');
    if (/[<>"'&\s]/.test(s)) throw new IdCardError('证件号不能包含空格或 < > " \' &。');
    return s;
}

function normalizeNote(raw) {
    return String(raw == null ? '' : raw).trim().slice(0, 255);
}

function parseVolunteerId(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const n = parseInt(raw, 10);
    if (!n) return null;
    return n;
}

function newScanToken() {
    return crypto.randomBytes(16).toString('hex');
}

let tokenReady = null;

async function ensureScanTokens() {
    if (tokenReady) return tokenReady;
    tokenReady = (async () => {
        const [cols] = await pool.query("SHOW COLUMNS FROM id_cards LIKE 'scan_token'");
        if (!cols.length) {
            await pool.query(
                'ALTER TABLE id_cards ADD COLUMN scan_token CHAR(32) NULL AFTER card_no'
            );
        }
        const [idx] = await pool.query("SHOW INDEX FROM id_cards WHERE Key_name = 'uk_id_cards_token'");
        if (!idx.length) {
            await pool.query('ALTER TABLE id_cards ADD UNIQUE KEY uk_id_cards_token (scan_token)');
        }
        const [missing] = await pool.query(
            "SELECT id FROM id_cards WHERE scan_token IS NULL OR scan_token = ''"
        );
        for (const row of missing) {
            for (let i = 0; i < 6; i++) {
                try {
                    await pool.query(
                        'UPDATE id_cards SET scan_token = ? WHERE id = ? AND (scan_token IS NULL OR scan_token = \'\')',
                        [newScanToken(), row.id]
                    );
                    break;
                } catch (err) {
                    if (!err || err.code !== 'ER_DUP_ENTRY') throw err;
                }
            }
        }
    })().catch((err) => {
        tokenReady = null;
        throw err;
    });
    return tokenReady;
}

async function withTx(fn) {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
        if (err && err.code === 'ER_DUP_ENTRY') {
            throw new IdCardError('证件号重复，或该队员已绑定其他证件。');
        }
        throw err;
    } finally {
        conn.release();
    }
}

async function loadCard(conn, id) {
    const [rows] = await conn.query('SELECT * FROM id_cards WHERE id=?', [id]);
    return rows[0] || null;
}

async function requireCard(conn, id) {
    const card = await loadCard(conn, parseInt(id, 10));
    if (!card) throw new IdCardError('未找到该证件。');
    return card;
}

async function requireVolunteer(conn, volunteerId) {
    const [rows] = await conn.query('SELECT id, name, badge_number, id_card_no FROM volunteers WHERE id=?', [volunteerId]);
    if (!rows.length) throw new IdCardError('未找到要绑定的队员。');
    return rows[0];
}

async function clearVolCardNo(conn, volunteerId, cardNo) {
    if (!volunteerId) return;
    await conn.query(
        'UPDATE volunteers SET id_card_no=NULL WHERE id=? AND id_card_no=?',
        [volunteerId, cardNo]
    );
}

async function releaseOtherCardsOfVolunteer(conn, volunteerId, exceptCardId) {
    const [rows] = await conn.query(
        'SELECT id, card_no, status FROM id_cards WHERE volunteer_id=? AND id<>?',
        [volunteerId, exceptCardId || 0]
    );
    for (const row of rows) {
        const nextStatus = row.status === 'lost' ? 'lost' : 'unbound';
        await conn.query(
            'UPDATE id_cards SET volunteer_id=NULL, status=? WHERE id=?',
            [nextStatus, row.id]
        );
        await clearVolCardNo(conn, volunteerId, row.card_no);
    }
}

/**
 * volunteerId 为 null：解绑，status 改为 unbound。
 * 有队员：一人一卡，先解绑该队员其它证；若本证已挂失则仍为 lost。
 */
async function applyBinding(conn, card, volunteerId) {
    const prevVid = card.volunteer_id ? Number(card.volunteer_id) : null;
    const vid = volunteerId || null;

    if (prevVid && prevVid !== vid) {
        await clearVolCardNo(conn, prevVid, card.card_no);
    }

    if (!vid) {
        await conn.query(
            'UPDATE id_cards SET volunteer_id=NULL, status=? WHERE id=?',
            ['unbound', card.id]
        );
        if (prevVid) await clearVolCardNo(conn, prevVid, card.card_no);
        return { unbound: true, switchedFrom: prevVid };
    }

    const vol = await requireVolunteer(conn, vid);
    await releaseOtherCardsOfVolunteer(conn, vid, card.id);
    const status = card.status === 'lost' ? 'lost' : 'bound';
    await conn.query(
        'UPDATE id_cards SET volunteer_id=?, status=? WHERE id=?',
        [vid, status, card.id]
    );
    await conn.query('UPDATE volunteers SET id_card_no=? WHERE id=?', [card.card_no, vid]);
    return { unbound: false, volunteer: vol, status };
}

async function createCard({ cardNo, note, volunteerId }) {
    await ensureScanTokens();
    const no = normalizeCardNo(cardNo);
    const noteVal = normalizeNote(note);
    const vid = parseVolunteerId(volunteerId);
    return withTx(async (conn) => {
        const [dup] = await conn.query('SELECT id FROM id_cards WHERE card_no=?', [no]);
        if (dup.length) throw new IdCardError('证件号已存在。');
        let ins;
        for (let i = 0; i < 6; i++) {
            try {
                [ins] = await conn.query(
                    "INSERT INTO id_cards (card_no, scan_token, note, volunteer_id, status) VALUES (?, ?, ?, NULL, 'unbound')",
                    [no, newScanToken(), noteVal]
                );
                break;
            } catch (err) {
                if (!err || err.code !== 'ER_DUP_ENTRY' || i === 5) throw err;
            }
        }
        const card = await loadCard(conn, ins.insertId);
        await applyBinding(conn, card, vid);
        return ins.insertId;
    });
}

async function saveCard({ id, note, volunteerId }) {
    const noteVal = normalizeNote(note);
    const vid = parseVolunteerId(volunteerId);
    return withTx(async (conn) => {
        const card = await requireCard(conn, id);
        await conn.query('UPDATE id_cards SET note=? WHERE id=?', [noteVal, card.id]);
        const latest = { ...card, note: noteVal };
        return applyBinding(conn, latest, vid);
    });
}

async function loseCard(id) {
    return withTx(async (conn) => {
        const card = await requireCard(conn, id);
        await conn.query("UPDATE id_cards SET status='lost' WHERE id=?", [card.id]);
        return card;
    });
}

async function restoreCard(id) {
    return withTx(async (conn) => {
        const card = await requireCard(conn, id);
        const status = card.volunteer_id ? 'bound' : 'unbound';
        await conn.query('UPDATE id_cards SET status=? WHERE id=?', [status, card.id]);
        return { ...card, status };
    });
}

async function deleteCard(id) {
    return withTx(async (conn) => {
        const card = await requireCard(conn, id);
        if (card.volunteer_id) {
            await clearVolCardNo(conn, card.volunteer_id, card.card_no);
        }
        await conn.query('DELETE FROM id_cards WHERE id=?', [card.id]);
        return card;
    });
}

async function listCards() {
    await ensureScanTokens();
    const [rows] = await pool.query(
        `SELECT c.id, c.card_no, c.scan_token, c.note, c.volunteer_id, c.status, c.created_at, c.updated_at,
                v.name AS volunteer_name, v.badge_number AS volunteer_badge
         FROM id_cards c
         LEFT JOIN volunteers v ON v.id = c.volunteer_id
         ORDER BY c.id DESC`
    );
    return rows;
}

const CARD_LOOKUP_SQL = `SELECT c.id, c.card_no, c.scan_token, c.note, c.volunteer_id, c.status,
                v.id AS vol_id, v.name, v.badge_number, v.blood_type, v.join_date, v.status AS vol_status, v.avatar_url
         FROM id_cards c
         LEFT JOIN volunteers v ON v.id = c.volunteer_id`;

async function getByCardNo(cardNo) {
    await ensureScanTokens();
    const no = String(cardNo == null ? '' : cardNo).trim();
    if (!no || no.length > 64) return null;
    const [byToken] = await pool.query(CARD_LOOKUP_SQL + ' WHERE c.scan_token = ? LIMIT 1', [no]);
    if (byToken[0]) return byToken[0];
    const [byNo] = await pool.query(CARD_LOOKUP_SQL + ' WHERE c.card_no = ? LIMIT 1', [no]);
    return byNo[0] || null;
}

async function unbindCardsOfDeletedVolunteer(volunteerId) {
    if (!volunteerId) return;
    await pool.query(
        "UPDATE id_cards SET volunteer_id=NULL, status=IF(status='lost','lost','unbound') WHERE volunteer_id=?",
        [volunteerId]
    );
}

module.exports = {
    IdCardError,
    createCard,
    saveCard,
    loseCard,
    restoreCard,
    deleteCard,
    listCards,
    getByCardNo,
    ensureScanTokens,
    unbindCardsOfDeletedVolunteer
};
