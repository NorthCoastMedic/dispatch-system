/**
 * 系统设置（跨模块）
 * 存 org 库 settings 表（连接读取 apps/portal/.env）
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadLocalEnv, envGet } = require('./env');

const LEGACY_JSON = path.join(__dirname, 'data', 'system-settings.json');

/** 分钟数字段工厂；opts.min 默认可为 0（重复提醒） */
function minField(label, defVal, opts = {}) {
    return {
        label,
        type: 'number',
        unit: '分钟',
        min: opts.min != null ? opts.min : 1,
        max: opts.max != null ? opts.max : 1440,
        default: String(defVal)
    };
}

/** 内部导航页卡片默认（与历史 dashboard 一致） */
const DEFAULT_NAV_ITEMS = [
    {
        id: 'rtls',
        icon: '📍',
        title: '实时定位系统',
        desc: '打开地图，追踪各单位坐标进行高效调度。',
        href: '/rtls/',
        target: '_self',
        admin_only: false,
        enabled: true,
        accent: ''
    },
    {
        id: 'rms',
        icon: '📟',
        title: '事件调度',
        desc: '进入事件调度系统和成员状态汇报系统。',
        href: '/rms/',
        target: '_self',
        admin_only: false,
        enabled: true,
        accent: ''
    },
    {
        id: 'wbgt',
        icon: '🌡️',
        title: 'WBGT 热环境',
        desc: '查看现场热应力与传感器实时数据。',
        href: '/wbgt/',
        target: '_self',
        admin_only: false,
        enabled: true,
        accent: ''
    },
    {
        id: 'ambulance',
        icon: '🚑',
        title: '救护车车牌查询',
        desc: '在新窗口查看救护车资质。',
        href: '#',
        target: '_blank',
        admin_only: false,
        enabled: false,
        accent: ''
    },
    {
        id: 'firstaid_form',
        icon: '📝',
        title: '电子急救表单',
        desc: '在新窗口快速录入现场急救数据。',
        href: '#',
        target: '_blank',
        admin_only: false,
        enabled: false,
        accent: ''
    },
    {
        id: 'public_site',
        icon: 'ℹ️',
        title: '组织队伍网站',
        desc: '组织信息公开网站（外链）。',
        href: '#',
        target: '_blank',
        admin_only: false,
        enabled: false,
        accent: ''
    },
    {
        id: 'dispatch',
        icon: '📠',
        title: '事件调度面板',
        desc: '显示成员状态',
        href: '/rms/dispatch.html',
        target: '_self',
        admin_only: true,
        enabled: true,
        accent: '#28a745'
    },
    {
        id: 'admin_edit',
        icon: '⚙️',
        title: '队员档案与资质管理',
        desc: '添加新队员、修改基础档案、颁发及注销内外资质证书。',
        href: '/admin_edit.php',
        target: '_self',
        admin_only: true,
        enabled: true,
        accent: '#28a745'
    },
    {
        id: 'system_settings',
        icon: '🛠️',
        title: '系统设置',
        desc: '修改平台名称、导航页、登录标题、公开网站与统一页脚文案。',
        href: '/system_settings.php',
        target: '_self',
        admin_only: true,
        enabled: true,
        accent: '#28a745'
    }
];

function normalizeNavItem(raw, idx) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const id = String(src.id || ('item_' + (idx + 1))).trim().slice(0, 64) || ('item_' + (idx + 1));
    let target = String(src.target || '_self').trim();
    if (target !== '_blank') target = '_self';
    let accent = String(src.accent || '').trim();
    if (accent && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) accent = '';
    return {
        id,
        icon: String(src.icon != null ? src.icon : '').trim().slice(0, 16),
        title: String(src.title || '').trim().slice(0, 80),
        desc: String(src.desc || '').trim().slice(0, 200),
        href: String(src.href || '').trim().slice(0, 500),
        target,
        admin_only: !!src.admin_only,
        enabled: src.enabled === false ? false : true,
        accent
    };
}

function parseNavItems(raw) {
    let list = null;
    if (Array.isArray(raw)) {
        list = raw;
    } else {
        const text = String(raw == null ? '' : raw).trim();
        if (!text) return DEFAULT_NAV_ITEMS.map((item, i) => normalizeNavItem(item, i));
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) list = parsed;
        } catch (_) {
            list = null;
        }
    }
    if (!list || !list.length) {
        return DEFAULT_NAV_ITEMS.map((item, i) => normalizeNavItem(item, i));
    }
    return list.map((item, i) => normalizeNavItem(item, i));
}

function stringifyNavItems(raw) {
    return JSON.stringify(parseNavItems(raw));
}

function getNavItemsFromSettings(settings) {
    const raw = settings && settings.nav && settings.nav.nav_items;
    return parseNavItems(raw);
}

/**
 * 分类定义
 * - fields: 扁平字段（系统信息 / 导航）
 * - sections → groups → fields: 分组字段（RMS SLA 等）
 */
const CATEGORY_DEFS = {
    branding: {
        label: '系统信息',
        description: '平台名称、登录/终端/展示标题、公开网站与页脚文案',
        fields: {
            internal_platform_name: {
                label: '内部平台名称（顶栏 Logo）',
                type: 'text',
                default: '内部平台'
            },
            login_title: {
                label: '登录页标题',
                type: 'text',
                default: '成员登录'
            },
            rms_terminal_title: {
                label: 'RMS 响应终端标题（/rms/index.html）',
                type: 'text',
                default: '响应终端'
            },
            rms_display_title: {
                label: 'RMS 状态展示页标题（/rms/display.html）',
                type: 'text',
                default: '调度状态展示'
            },
            rms_display_banner_enabled: {
                label: '状态展示页只读提示条',
                type: 'toggle',
                options: [
                    { value: '1', label: '打开' },
                    { value: '0', label: '关闭' }
                ],
                default: '1'
            },
            public_site_url: {
                label: '组织信息公开网站网址',
                type: 'url',
                default: 'https://example.com/'
            },
            public_site_label: {
                label: '公开网站链接文案',
                type: 'text',
                default: '组织信息公开网站'
            },
            footer_copyright: {
                label: '页脚版权行',
                type: 'text',
                default: '© 组织名称. 保留所有权利。'
            },
            footer_motto: {
                label: '页脚标语（与版权分行）',
                type: 'text',
                default: ''
            }
        }
    },
    nav: {
        label: '导航页',
        description: '内部导航页模块卡片：图标、名称、简介、跳转链接与排序',
        fields: {
            nav_items: {
                label: '导航卡片列表',
                type: 'nav_items',
                default: JSON.stringify(DEFAULT_NAV_ITEMS)
            }
        }
    },
    rms: {
        label: 'RMS',
        description: '事件调度相关参数',
        sections: {
            sla: {
                label: '事件超时 / SLA 提醒',
                description: '按求助类型与优先级设置预告、超时、超时后重复提醒（分钟）。预告须小于超时；重复为 0 表示超时只提醒一次。任意指派人员标记「到达现场」后停止该事件 SLA。',
                groups: {
                    medical: {
                        label: '医疗事件求助',
                        report_type: '医疗事件求助',
                        fields: {
                            sla_medical_high_warn: minField('高优先级 · 预告', 1),
                            sla_medical_high_timeout: minField('高优先级 · 超时', 3),
                            sla_medical_high_repeat: minField('高优先级 · 超时后重复', 0, { min: 0 }),
                            sla_medical_mid_warn: minField('中优先级 · 预告', 3),
                            sla_medical_mid_timeout: minField('中优先级 · 超时', 8),
                            sla_medical_mid_repeat: minField('中优先级 · 超时后重复', 0, { min: 0 }),
                            sla_medical_low_warn: minField('低优先级 · 预告', 5),
                            sla_medical_low_timeout: minField('低优先级 · 超时', 15),
                            sla_medical_low_repeat: minField('低优先级 · 超时后重复', 0, { min: 0 })
                        }
                    },
                    safety: {
                        label: '安全问题求助',
                        report_type: '安全问题求助',
                        fields: {
                            sla_safety_high_warn: minField('高优先级 · 预告', 2),
                            sla_safety_high_timeout: minField('高优先级 · 超时', 5),
                            sla_safety_high_repeat: minField('高优先级 · 超时后重复', 0, { min: 0 }),
                            sla_safety_mid_warn: minField('中优先级 · 预告', 5),
                            sla_safety_mid_timeout: minField('中优先级 · 超时', 12),
                            sla_safety_mid_repeat: minField('中优先级 · 超时后重复', 0, { min: 0 }),
                            sla_safety_low_warn: minField('低优先级 · 预告', 10),
                            sla_safety_low_timeout: minField('低优先级 · 超时', 20),
                            sla_safety_low_repeat: minField('低优先级 · 超时后重复', 0, { min: 0 })
                        }
                    },
                    other: {
                        label: '其他问题求助',
                        report_type: '其他问题求助',
                        fields: {
                            sla_other_high_warn: minField('高优先级 · 预告', 5),
                            sla_other_high_timeout: minField('高优先级 · 超时', 10),
                            sla_other_high_repeat: minField('高优先级 · 超时后重复', 0, { min: 0 }),
                            sla_other_mid_warn: minField('中优先级 · 预告', 10),
                            sla_other_mid_timeout: minField('中优先级 · 超时', 20),
                            sla_other_mid_repeat: minField('中优先级 · 超时后重复', 0, { min: 0 }),
                            sla_other_low_warn: minField('低优先级 · 预告', 15),
                            sla_other_low_timeout: minField('低优先级 · 超时', 30),
                            sla_other_low_repeat: minField('低优先级 · 超时后重复', 0, { min: 0 })
                        }
                    }
                }
            },
            agency: {
                label: 'Agency / 分区',
                description: '配置调度分区名称列表（每行一个）。队员在档案中选择分区；dispatch 人员列表可按分区过滤。分区名称写入 volunteers.agency。',
                fields: {
                    agency_list: {
                        label: '分区名称列表',
                        type: 'textarea',
                        rows: 6,
                        placeholder: '例如：\n一区\n二区\n机动组',
                        normalize: 'agency_list',
                        default: ''
                    }
                }
            },
            wecom: {
                label: '企业微信通知',
                description: '群机器人 Webhook。用于指派、单呼、广播等 @ 通知。留空则回退到 apps/rms/.env 的 WECOM_WEBHOOK_URL。',
                fields: {
                    wecom_webhook_url: {
                        label: 'WECOM_WEBHOOK_URL（群机器人地址）',
                        type: 'url',
                        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
                        default: ''
                    }
                }
            },
            terminal: {
                label: '响应终端',
                description: '成员终端（/rms/index.html）上的急救表单入口。可改显示名称与跳转链接；关闭后终端不显示该按钮。',
                fields: {
                    rms_firstaid_form_enabled: {
                        label: '显示急救表单入口',
                        type: 'toggle',
                        options: [
                            { value: '1', label: '打开' },
                            { value: '0', label: '关闭' }
                        ],
                        default: '1'
                    },
                    rms_firstaid_form_label: {
                        label: '急救表单按钮文案',
                        type: 'text',
                        default: '急救表单'
                    },
                    rms_firstaid_form_url: {
                        label: '急救表单链接',
                        type: 'url',
                        placeholder: 'https://...',
                        default: ''
                    }
                }
            },
            display: {
                label: '展示面板',
                description: '状态展示页（/rms/display.html）统计图设置。数据较少时可关闭图表，或开启范围轮换轮流看进行中/已完成/全部。',
                fields: {
                    rms_display_charts_enabled: {
                        label: '显示统计图表',
                        type: 'toggle',
                        options: [
                            { value: '1', label: '打开' },
                            { value: '0', label: '关闭' }
                        ],
                        default: '1'
                    },
                    rms_display_chart_scope_default: {
                        label: '统计默认范围',
                        type: 'select',
                        options: [
                            { value: 'active', label: '进行中' },
                            { value: 'completed', label: '已完成' },
                            { value: 'all', label: '全部' }
                        ],
                        default: 'active'
                    },
                    rms_display_chart_rotate: {
                        label: '统计范围自动轮换',
                        type: 'toggle',
                        options: [
                            { value: '1', label: '打开' },
                            { value: '0', label: '关闭' }
                        ],
                        default: '0'
                    },
                    rms_display_chart_skip_empty: {
                        label: '轮换时跳过无数据范围',
                        type: 'toggle',
                        options: [
                            { value: '1', label: '打开' },
                            { value: '0', label: '关闭' }
                        ],
                        default: '1'
                    },
                    rms_display_chart_rotate_sec: {
                        label: '轮换间隔',
                        type: 'number',
                        unit: '秒',
                        min: 5,
                        max: 600,
                        default: '30'
                    }
                }
            }
        }
    }
};

/** 优先级码与键名对应（与 RMS priority 1/2/3 一致） */
const SLA_PRIORITY_KEYS = {
    1: 'high',
    2: 'mid',
    3: 'low'
};

const SLA_TYPE_KEYS = {
    '医疗事件求助': 'medical',
    '安全问题求助': 'safety',
    '其他问题求助': 'other'
};

let pool = null;
let cache = null;
let readyPromise = null;

/** 取出某分类下全部字段定义 { key: fieldDef } */
function collectCategoryFields(catDef) {
    const fields = {};
    if (catDef.fields) {
        Object.assign(fields, catDef.fields);
    }
    if (catDef.sections) {
        for (const section of Object.values(catDef.sections)) {
            if (section.fields) Object.assign(fields, section.fields);
            if (section.groups) {
                for (const group of Object.values(section.groups)) {
                    if (group.fields) Object.assign(fields, group.fields);
                }
            }
        }
    }
    return fields;
}

function defaults() {
    const out = {};
    for (const [cat, def] of Object.entries(CATEGORY_DEFS)) {
        out[cat] = {};
        const fields = collectCategoryFields(def);
        for (const [key, field] of Object.entries(fields)) {
            out[cat][key] = field.default;
        }
    }
    return out;
}

function getPool() {
    if (pool) return pool;
    const portalEnv = loadLocalEnv(path.join(__dirname, '..', 'portal'));
    pool = mysql.createPool({
        host: envGet(portalEnv, 'DB_HOST', '127.0.0.1'),
        port: Number(envGet(portalEnv, 'DB_PORT', '3306')),
        user: envGet(portalEnv, 'DB_USER', 'org'),
        password: envGet(portalEnv, 'DB_PASSWORD', ''),
        database: envGet(portalEnv, 'DB_NAME', 'org'),
        waitForConnections: true,
        connectionLimit: 5,
        charset: 'utf8mb4'
    });
    return pool;
}

function normalizeFieldValue(fieldDef, raw) {
    if (fieldDef && fieldDef.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return fieldDef.default;
        const min = fieldDef.min != null ? fieldDef.min : 1;
        const max = fieldDef.max != null ? fieldDef.max : 1440;
        const clamped = Math.min(max, Math.max(min, Math.round(n)));
        return String(clamped);
    }
    if (fieldDef && fieldDef.normalize === 'agency_list') {
        return parseAgencyList(raw).join('\n');
    }
    if (fieldDef && fieldDef.type === 'nav_items') {
        return stringifyNavItems(raw);
    }
    if (fieldDef && fieldDef.type === 'toggle') {
        const v = String(raw == null ? '' : raw).trim().toLowerCase();
        if (v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === '打开') return '1';
        if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '关闭') return '0';
        return fieldDef.default === '0' ? '0' : '1';
    }
    return raw == null ? '' : String(raw).trim();
}

/** 分区列表：按行/逗号拆分去重 */
function parseAgencyList(raw) {
    return String(raw || '')
        .split(/[\n\r,，;；]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i);
}

function getAgencyListFromSettings(settings) {
    const raw = settings && settings.rms && settings.rms.agency_list;
    return parseAgencyList(raw);
}

function deepMergeKnown(base, incoming) {
    const result = JSON.parse(JSON.stringify(base));
    if (!incoming || typeof incoming !== 'object') return result;
    for (const [cat, def] of Object.entries(CATEGORY_DEFS)) {
        if (!incoming[cat] || typeof incoming[cat] !== 'object') continue;
        if (!result[cat]) result[cat] = {};
        const fields = collectCategoryFields(def);
        for (const key of Object.keys(fields)) {
            if (Object.prototype.hasOwnProperty.call(incoming[cat], key)) {
                result[cat][key] = normalizeFieldValue(fields[key], incoming[cat][key]);
            }
        }
    }
    return result;
}

function validateSettings(settings) {
    const errors = [];
    const url = settings.branding && settings.branding.public_site_url;
    if (url) {
        try {
            const u = new URL(url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                errors.push('公开网站网址必须以 http:// 或 https:// 开头');
            }
        } catch {
            errors.push('公开网站网址格式无效');
        }
    } else {
        errors.push('公开网站网址不能为空');
    }
    const b = settings.branding || {};
    if (!b.internal_platform_name) errors.push('内部平台名称不能为空');
    if (!b.login_title) errors.push('登录页标题不能为空');
    if (!b.rms_terminal_title) errors.push('RMS 响应终端标题不能为空');
    if (!b.rms_display_title) errors.push('RMS 状态展示页标题不能为空');
    if (!b.footer_copyright) errors.push('页脚版权行不能为空');

    const navItems = getNavItemsFromSettings(settings);
    if (!navItems.length) {
        errors.push('导航页至少需要一张卡片');
    } else {
        navItems.forEach((item, i) => {
            const n = i + 1;
            if (!item.title) errors.push(`导航卡片 #${n}：名称不能为空`);
            if (!item.href) errors.push(`导航卡片 #${n}：跳转地址不能为空`);
        });
    }

    const rms = settings.rms || {};
    const wecomUrl = String(rms.wecom_webhook_url || '').trim();
    if (wecomUrl) {
        try {
            const u = new URL(wecomUrl);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                errors.push('企业微信 Webhook 网址必须以 http:// 或 https:// 开头');
            }
        } catch {
            errors.push('企业微信 Webhook 网址格式无效');
        }
    }
    const firstaidOn = String(rms.rms_firstaid_form_enabled || '1') === '1';
    const firstaidLabel = String(rms.rms_firstaid_form_label || '').trim();
    const firstaidUrl = String(rms.rms_firstaid_form_url || '').trim();
    if (firstaidOn) {
        if (!firstaidLabel) errors.push('急救表单按钮文案不能为空');
        if (!firstaidUrl) {
            errors.push('急救表单链接不能为空');
        } else {
            try {
                const u = new URL(firstaidUrl);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                    errors.push('急救表单链接必须以 http:// 或 https:// 开头');
                }
            } catch {
                errors.push('急救表单链接格式无效');
            }
        }
    } else if (firstaidUrl) {
        try {
            const u = new URL(firstaidUrl);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                errors.push('急救表单链接必须以 http:// 或 https:// 开头');
            }
        } catch {
            errors.push('急救表单链接格式无效');
        }
    }
    const chartScope = String(rms.rms_display_chart_scope_default || 'active').trim();
    if (!['active', 'completed', 'all'].includes(chartScope)) {
        errors.push('展示面板统计默认范围无效');
    }
    const rotateSec = Number(rms.rms_display_chart_rotate_sec);
    if (!Number.isFinite(rotateSec) || rotateSec < 5 || rotateSec > 600) {
        errors.push('展示面板轮换间隔须在 5～600 秒');
    }
    const pairs = [
        ['医疗事件求助', 'sla_medical'],
        ['安全问题求助', 'sla_safety'],
        ['其他问题求助', 'sla_other']
    ];
    const levels = [
        ['高优先级', 'high'],
        ['中优先级', 'mid'],
        ['低优先级', 'low']
    ];
    for (const [typeLabel, prefix] of pairs) {
        for (const [levelLabel, level] of levels) {
            const warnKey = `${prefix}_${level}_warn`;
            const timeoutKey = `${prefix}_${level}_timeout`;
            const repeatKey = `${prefix}_${level}_repeat`;
            const warn = Number(rms[warnKey]);
            const timeout = Number(rms[timeoutKey]);
            const repeat = Number(rms[repeatKey]);
            if (!Number.isFinite(warn) || warn < 1) {
                errors.push(`${typeLabel} · ${levelLabel}：预告分钟无效`);
            }
            if (!Number.isFinite(timeout) || timeout < 1) {
                errors.push(`${typeLabel} · ${levelLabel}：超时分钟无效`);
            }
            if (Number.isFinite(warn) && Number.isFinite(timeout) && warn >= timeout) {
                errors.push(`${typeLabel} · ${levelLabel}：预告须小于超时（当前 ${warn} ≥ ${timeout}）`);
            }
            if (!Number.isFinite(repeat) || repeat < 0) {
                errors.push(`${typeLabel} · ${levelLabel}：超时后重复分钟无效（可为 0）`);
            }
        }
    }
    return errors;
}

function rowsToSettings(rows) {
    const settings = defaults();
    for (const row of rows || []) {
        const cat = row.category;
        const key = row.setting_key;
        if (settings[cat] && Object.prototype.hasOwnProperty.call(settings[cat], key)) {
            const fieldDef = collectCategoryFields(CATEGORY_DEFS[cat])[key];
            settings[cat][key] = normalizeFieldValue(fieldDef, row.setting_value);
        }
    }
    return settings;
}

async function ensureTable() {
    const db = getPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS settings (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            category VARCHAR(64) NOT NULL COMMENT '分类，如 branding / rms',
            setting_key VARCHAR(128) NOT NULL COMMENT '键名',
            setting_value TEXT NOT NULL COMMENT '值',
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_settings_cat_key (category, setting_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='统一平台系统设置'
    `);
}

function readLegacyJson() {
    try {
        if (!fs.existsSync(LEGACY_JSON)) return null;
        return JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    } catch {
        return null;
    }
}

async function upsertAllDefaults(seed) {
    const db = getPool();
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        for (const [cat, fields] of Object.entries(seed)) {
            for (const [key, value] of Object.entries(fields)) {
                await conn.query(
                    `INSERT INTO settings (category, setting_key, setting_value)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE setting_value = setting_value`,
                    [cat, key, value]
                );
            }
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** 空表种子；已有表则只补缺失键（不覆盖已改值） */
async function seedDefaults() {
    const db = getPool();
    const [rows] = await db.query('SELECT COUNT(*) AS c FROM settings');
    let seed = defaults();
    if (Number(rows[0].c) === 0) {
        const legacy = readLegacyJson();
        if (legacy) {
            seed = deepMergeKnown(seed, legacy);
            console.log('[systemSettings] 已从旧 JSON 迁入默认种子（仅空表时一次）');
        }
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            for (const [cat, fields] of Object.entries(seed)) {
                for (const [key, value] of Object.entries(fields)) {
                    await conn.query(
                        `INSERT INTO settings (category, setting_key, setting_value)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                        [cat, key, value]
                    );
                }
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        return;
    }
    // 表已有数据：只插入缺失的新键（如本次新增的 rms SLA）
    await upsertAllDefaults(defaults());
}

async function refreshCache() {
    const db = getPool();
    const [rows] = await db.query(
        'SELECT category, setting_key, setting_value FROM settings'
    );
    cache = rowsToSettings(rows);
    return cache;
}

async function ensureReady() {
    if (!readyPromise) {
        readyPromise = (async () => {
            await ensureTable();
            await seedDefaults();
            await refreshCache();
        })().catch((err) => {
            readyPromise = null;
            console.error('[systemSettings] 初始化失败:', err.message);
            throw err;
        });
    }
    return readyPromise;
}

async function loadSettings() {
    try {
        await ensureReady();
        return await refreshCache();
    } catch (err) {
        console.error('[systemSettings] 读取失败，使用默认/缓存:', err.message);
        return cache || defaults();
    }
}

async function saveSettings(incoming, meta = {}) {
    const current = await loadSettings();
    const merged = deepMergeKnown(current, incoming);
    const errors = validateSettings(merged);
    if (errors.length) {
        return { ok: false, errors, settings: merged };
    }

    const db = getPool();
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        for (const [cat, def] of Object.entries(CATEGORY_DEFS)) {
            const fields = collectCategoryFields(def);
            for (const key of Object.keys(fields)) {
                const value = merged[cat][key];
                await conn.query(
                    `INSERT INTO settings (category, setting_key, setting_value)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                    [cat, key, value]
                );
            }
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        console.error('[systemSettings] 保存失败:', err.message);
        return { ok: false, errors: ['数据库保存失败：' + err.message], settings: merged };
    } finally {
        conn.release();
    }

    cache = merged;
    try {
        const { writeSettingsLog } = require('../portal/lib/orgLog');
        await writeSettingsLog(db, {
            action: 'update_settings',
            actorUserId: meta.actorUserId != null ? meta.actorUserId : null,
            actorUsername: meta.actorUsername || null,
            summary: '保存系统设置',
            before: current,
            after: merged,
            detail: { categories: Object.keys(CATEGORY_DEFS) },
            ip: meta.ip || null
        });
    } catch (logErr) {
        console.warn('[systemSettings] 写设置日志失败:', logErr.message);
    }
    return { ok: true, errors: [], settings: merged };
}

function getCategoryDefs() {
    return CATEGORY_DEFS;
}

function getBranding() {
    return (cache || defaults()).branding;
}

async function getBrandingAsync() {
    const settings = await loadSettings();
    return settings.branding;
}

/**
 * 根据求助类型文案 + 优先级(1高/2中/3低) 取 SLA 分钟
 * @returns {{ warnMinutes: number, timeoutMinutes: number, repeatMinutes: number } | null}
 */
function resolveSlaFromSettings(settings, reportTypeLabel, priority) {
    const typeKey = SLA_TYPE_KEYS[reportTypeLabel] || 'other';
    const level = SLA_PRIORITY_KEYS[Number(priority)] || 'low';
    const rms = (settings && settings.rms) || defaults().rms;
    const warn = Number(rms[`sla_${typeKey}_${level}_warn`]);
    const timeout = Number(rms[`sla_${typeKey}_${level}_timeout`]);
    const repeat = Number(rms[`sla_${typeKey}_${level}_repeat`]);
    if (!Number.isFinite(warn) || !Number.isFinite(timeout)) return null;
    return {
        warnMinutes: warn,
        timeoutMinutes: timeout,
        repeatMinutes: Number.isFinite(repeat) && repeat >= 0 ? repeat : 0
    };
}

const SECRET_SETTING_KEYS = new Set(['wecom_webhook_url']);

/** 非管理员读接口去掉密钥，页面功能仍可用（品牌/导航不依赖 Webhook） */
function redactSettingsForClient(settings, includeSecrets) {
    if (includeSecrets) return settings;
    let out;
    try {
        out = JSON.parse(JSON.stringify(settings || {}));
    } catch {
        return settings;
    }
    Object.keys(out).forEach((cat) => {
        const bag = out[cat];
        if (!bag || typeof bag !== 'object') return;
        Object.keys(bag).forEach((key) => {
            if (!SECRET_SETTING_KEYS.has(key)) return;
            if (String(bag[key] || '').trim()) bag[key] = '';
        });
    });
    return out;
}

module.exports = {
    CATEGORY_DEFS,
    DEFAULT_NAV_ITEMS,
    getCategoryDefs,
    loadSettings,
    saveSettings,
    redactSettingsForClient,
    getBranding,
    getBrandingAsync,
    ensureReady,
    defaults,
    resolveSlaFromSettings,
    parseAgencyList,
    getAgencyListFromSettings,
    parseNavItems,
    getNavItemsFromSettings,
    SLA_TYPE_KEYS,
    SLA_PRIORITY_KEYS
};
