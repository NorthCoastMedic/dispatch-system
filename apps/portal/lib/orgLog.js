/**
 * Portal / org 库日志：系统设置、档案资质
 */
let ensured = false;

function toJson(val) {
    if (val == null) return null;
    if (typeof val === 'string') return val.slice(0, 12000);
    try {
        return JSON.stringify(val).slice(0, 12000);
    } catch (_) {
        return String(val).slice(0, 12000);
    }
}

async function ensureOrgLogTables(db) {
    if (!db || ensured) return;
    const q = typeof db.query === 'function' ? db.query.bind(db) : null;
    if (!q) return;
    await q(`
        CREATE TABLE IF NOT EXISTS org_settings_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          action VARCHAR(64) NOT NULL DEFAULT 'update_settings',
          actor_user_id INT NULL,
          actor_username VARCHAR(64) NULL,
          category VARCHAR(64) NULL,
          summary VARCHAR(500) NOT NULL,
          before_json JSON NULL,
          after_json JSON NULL,
          detail JSON NULL,
          ip VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_osl_time (created_at),
          KEY idx_osl_actor (actor_user_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await q(`
        CREATE TABLE IF NOT EXISTS org_profile_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          action VARCHAR(64) NOT NULL,
          actor_user_id INT NULL,
          actor_username VARCHAR(64) NULL,
          volunteer_id INT NOT NULL,
          volunteer_name VARCHAR(128) NULL,
          target_user_id INT NULL,
          entity_type VARCHAR(32) NULL,
          entity_id INT NULL,
          summary VARCHAR(500) NOT NULL,
          before_json JSON NULL,
          after_json JSON NULL,
          detail JSON NULL,
          ip VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_opl_vol_time (volunteer_id, created_at),
          KEY idx_opl_action_time (action, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    for (const table of ['org_settings_logs', 'org_profile_logs']) {
        for (const [col, def] of [['device', 'VARCHAR(255) NULL'], ['user_agent', 'VARCHAR(512) NULL']]) {
            try {
                await q(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
            } catch (err) {
                if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
            }
        }
    }
    ensured = true;
}

async function writeSettingsLog(db, entry = {}) {
    if (!db) return;
    try {
        await ensureOrgLogTables(db);
        await db.query(
            `INSERT INTO org_settings_logs
             (action, actor_user_id, actor_username, category, summary, before_json, after_json, detail, ip, device, user_agent)
             VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)`,
            [
                String(entry.action || 'update_settings').slice(0, 64),
                entry.actorUserId != null ? entry.actorUserId : null,
                entry.actorUsername != null ? String(entry.actorUsername).slice(0, 64) : null,
                entry.category != null ? String(entry.category).slice(0, 64) : null,
                String(entry.summary || '更新系统设置').slice(0, 500),
                toJson(entry.before),
                toJson(entry.after),
                toJson(entry.detail),
                entry.ip != null ? String(entry.ip).slice(0, 64) : null,
                entry.device != null ? String(entry.device).slice(0, 255) : null,
                entry.userAgent != null ? String(entry.userAgent).slice(0, 512) : null
            ]
        );
    } catch (err) {
        console.error('[org_settings_logs]', err.message);
    }
}

async function writeProfileLog(db, entry = {}) {
    if (!db || entry.volunteerId == null) return;
    try {
        await ensureOrgLogTables(db);
        await db.query(
            `INSERT INTO org_profile_logs
             (action, actor_user_id, actor_username, volunteer_id, volunteer_name, target_user_id,
              entity_type, entity_id, summary, before_json, after_json, detail, ip, device, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)`,
            [
                String(entry.action || 'update_volunteer').slice(0, 64),
                entry.actorUserId != null ? entry.actorUserId : null,
                entry.actorUsername != null ? String(entry.actorUsername).slice(0, 64) : null,
                entry.volunteerId,
                entry.volunteerName != null ? String(entry.volunteerName).slice(0, 128) : null,
                entry.targetUserId != null ? entry.targetUserId : null,
                entry.entityType != null ? String(entry.entityType).slice(0, 32) : null,
                entry.entityId != null ? entry.entityId : null,
                String(entry.summary || entry.action || '档案变更').slice(0, 500),
                toJson(entry.before),
                toJson(entry.after),
                toJson(entry.detail),
                entry.ip != null ? String(entry.ip).slice(0, 64) : null,
                entry.device != null ? String(entry.device).slice(0, 255) : null,
                entry.userAgent != null ? String(entry.userAgent).slice(0, 512) : null
            ]
        );
    } catch (err) {
        console.error('[org_profile_logs]', err.message);
    }
}

module.exports = {
    ensureOrgLogTables,
    writeSettingsLog,
    writeProfileLog
};
