/**
 * 重复上报检测（最简版）
 * 规则：未完成 + 最近 N 分钟内 + 地点(title)规范化后相同
 */

const DEFAULT_WITHIN_MINUTES = 30;

function normalizeTitle(title) {
    return String(title || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[　\t\r\n]/g, '');
}

/**
 * @returns {Promise<Array<{id,title,description,created_at,priority,status}>>}
 */
async function findDuplicateEvents(db, title, options = {}) {
    const withinMinutes = Number(options.withinMinutes) || DEFAULT_WITHIN_MINUTES;
    const norm = normalizeTitle(title);
    if (!norm || !db) return [];

    const [rows] = await db.query(
        `SELECT id, title, description, created_at, priority, status
         FROM events
         WHERE status = '未完成'
           AND created_at >= (NOW() - INTERVAL ? MINUTE)
         ORDER BY created_at DESC
         LIMIT 50`,
        [withinMinutes]
    );

    return (rows || []).filter((row) => normalizeTitle(row.title) === norm);
}

function formatDuplicateHint(duplicates, withinMinutes = DEFAULT_WITHIN_MINUTES) {
    if (!duplicates.length) return '';
    const lines = duplicates.slice(0, 3).map((d) => {
        const t = d.created_at ? new Date(d.created_at).toLocaleString('zh-CN') : '';
        return `#${d.id} ${d.title}${t ? '（' + t + '）' : ''}`;
    });
    return `检测到 ${withinMinutes} 分钟内已有相同地点的未完成事件：\n${lines.join('\n')}\n\n若确认是另一起事件，可继续提交；否则请取消。`;
}

module.exports = {
    DEFAULT_WITHIN_MINUTES,
    normalizeTitle,
    findDuplicateEvents,
    formatDuplicateHint
};
