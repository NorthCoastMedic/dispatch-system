/**
 * 调度状态展示页（大屏只读）
 * 全屏态势板：放大字号、弱化账号区；不可指派/改事件/广播。
 */
let currentUser = null;
let socket = null;
let allEvents = [];
let allUsers = [];
let agencyFilter = '';
let agencyListFromSettings = [];
let latestDashboardUsers = [];
let latestDashboardEvents = [];
let openEventDetailId = null;
let chartType = null;
let chartPriority = null;
let chartScope = 'active'; // active | completed | all
let chartsEnabled = true;
let chartRotate = false;
let chartSkipEmpty = true;
let chartRotateSec = 30;
let chartRotateTimer = null;
const CHART_SCOPE_ORDER = ['active', 'completed', 'all'];
const CHART_SCOPE_LABEL = { active: '进行中', completed: '已完成', all: '全部' };

document.addEventListener('DOMContentLoaded', async () => {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (!data.success || data.user.role !== 'admin') {
        window.location.href = '/login.php?redirect=' + encodeURIComponent('/rms/display.html');
        return;
    }
    currentUser = data.user;

    initHeader(currentUser);
    initDisplayClock();
    initEventCharts();
    await loadDisplaySettings();
    await loadAgencySettings();

    socket = io(window.Platform ? window.Platform.ioOptions() : { path: '/rms/socket.io' });
    if (typeof initEmergencyListener === 'function') initEmergencyListener(socket);

    socket.on('data_updated', (payload) => {
        allUsers = payload.users || [];
        allEvents = payload.events || [];
        renderDashboard(payload.users, payload.events);
        if (openEventDetailId) refreshOpenEventDrawer();
    });

    bindDisplayUi();
    setInterval(() => {
        loadAgencySettings();
        loadDisplaySettings({ quiet: true });
    }, 30000);
});

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 大屏时钟：硬朗等宽数字，避免 toLocaleString 圆润观感 */
function initDisplayClock() {
    const oldClock = document.getElementById('header-clock');
    if (!oldClock || !oldClock.parentNode) return;
    const clockEl = oldClock.cloneNode(false);
    clockEl.id = 'header-clock';
    clockEl.className = oldClock.className;
    oldClock.parentNode.replaceChild(clockEl, oldClock);

    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
        const now = new Date();
        clockEl.textContent =
            `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
}

function themeIsDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

function chartTextColor() {
    return themeIsDark() ? '#b8c7da' : '#5a6b7d';
}

function initEventCharts() {
    if (typeof echarts === 'undefined') return;
    const typeEl = document.getElementById('chart-event-type');
    const prioEl = document.getElementById('chart-event-priority');
    if (typeEl) chartType = echarts.init(typeEl);
    if (prioEl) chartPriority = echarts.init(prioEl);

    window.addEventListener('resize', () => {
        if (chartType) chartType.resize();
        if (chartPriority) chartPriority.resize();
    });

    const mo = new MutationObserver(() => {
        renderEventCharts(latestDashboardEvents || []);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

async function loadDisplaySettings(opts = {}) {
    try {
        const res = await fetch('/api/system-settings', { credentials: 'same-origin' });
        const data = await res.json();
        if (!data || !data.success || !data.settings || !data.settings.rms) return;
        const rms = data.settings.rms;
        const nextEnabled = String(rms.rms_display_charts_enabled || '1') === '1';
        const nextScope = ['active', 'completed', 'all'].includes(rms.rms_display_chart_scope_default)
            ? rms.rms_display_chart_scope_default
            : 'active';
        const nextRotate = String(rms.rms_display_chart_rotate || '0') === '1';
        const nextSkipEmpty = String(rms.rms_display_chart_skip_empty || '1') === '1';
        let nextSec = Number(rms.rms_display_chart_rotate_sec);
        if (!Number.isFinite(nextSec)) nextSec = 30;
        nextSec = Math.min(600, Math.max(5, Math.round(nextSec)));

        chartsEnabled = nextEnabled;
        chartRotate = nextRotate;
        chartSkipEmpty = nextSkipEmpty;
        chartRotateSec = nextSec;

        if (!opts.quiet) {
            chartScope = nextScope;
        }

        applyChartsEnabled();
        syncScopeTabs();
        setupChartRotation();
        renderEventCharts(latestDashboardEvents || []);
    } catch (e) {
        console.log('展示面板设置读取失败', e && e.message ? e.message : e);
    }
}

function applyChartsEnabled() {
    const stats = document.getElementById('dw-stats');
    if (!stats) return;
    stats.classList.toggle('is-hidden', !chartsEnabled);
    stats.style.display = chartsEnabled ? '' : 'none';
    document.body.classList.toggle('dw-no-charts', !chartsEnabled);
}

function syncScopeTabs() {
    document.querySelectorAll('#chart-scope-tabs .dw-scope-tab').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-scope') === chartScope);
    });
}

function setupChartRotation() {
    if (chartRotateTimer) {
        clearInterval(chartRotateTimer);
        chartRotateTimer = null;
    }
    if (!chartsEnabled || !chartRotate) return;
    chartRotateTimer = setInterval(() => {
        const next = nextChartScope(chartScope);
        if (next === chartScope) return;
        chartScope = next;
        syncScopeTabs();
        renderEventCharts(latestDashboardEvents || []);
    }, chartRotateSec * 1000);
}

/** 找下一个统计范围；开启跳过空数据时，避开 0 件的范围 */
function nextChartScope(fromScope) {
    const start = Math.max(0, CHART_SCOPE_ORDER.indexOf(fromScope));
    for (let step = 1; step <= CHART_SCOPE_ORDER.length; step++) {
        const cand = CHART_SCOPE_ORDER[(start + step) % CHART_SCOPE_ORDER.length];
        if (!chartSkipEmpty) return cand;
        const count = filterEventsByScope(latestDashboardEvents || [], cand).length;
        if (count > 0) return cand;
    }
    // 全部范围都没数据：停在当前，避免空转
    return fromScope;
}

function setChartScope(scope, fromUser) {
    if (!['active', 'completed', 'all'].includes(scope)) return;
    chartScope = scope;
    syncScopeTabs();
    if (fromUser) {
        // 手动切换后重启轮换计时，避免刚点就被切走
        setupChartRotation();
    }
    renderEventCharts(latestDashboardEvents || []);
}

function filterEventsByScope(events, scope) {
    const list = events || [];
    if (scope === 'completed') return list.filter((ev) => ev && ev.status === '已完成');
    if (scope === 'all') return list.slice();
    return list.filter((ev) => ev && ev.status === '未完成');
}

function eventTypeLabel(ev) {
    const fromField = String(ev && ev.report_type || '').trim();
    if (['医疗事件求助', '安全问题求助', '其他问题求助'].includes(fromField)) return fromField;
    const parsed = parseReportTypeFromDescription(ev && ev.description);
    return parsed || '未分类';
}

function renderEventCharts(events) {
    if (!chartsEnabled) return;

    const list = filterEventsByScope(events, chartScope);
    const meta = document.getElementById('chart-scope-meta');
    if (meta) meta.textContent = `${CHART_SCOPE_LABEL[chartScope] || ''} · ${list.length} 件`;

    const chartsEl = document.getElementById('dw-charts');
    const emptyEl = document.getElementById('dw-charts-empty');
    const statsEl = document.getElementById('dw-stats');
    const isEmpty = list.length === 0;

    if (statsEl) statsEl.classList.toggle('is-empty', isEmpty);
    if (chartsEl) chartsEl.classList.toggle('hidden', isEmpty);
    if (emptyEl) emptyEl.classList.toggle('hidden', !isEmpty);

    if (isEmpty) {
        if (chartType) chartType.clear();
        if (chartPriority) chartPriority.clear();
        return;
    }

    const typeOrder = ['医疗事件求助', '安全问题求助', '其他问题求助', '未分类'];
    const typeColors = {
        '医疗事件求助': '#dc2626',
        '安全问题求助': '#d97706',
        '其他问题求助': '#0056b3',
        '未分类': '#94a3b8'
    };
    const typeCount = { '医疗事件求助': 0, '安全问题求助': 0, '其他问题求助': 0, '未分类': 0 };
    list.forEach((ev) => {
        const t = eventTypeLabel(ev);
        if (typeCount[t] == null) typeCount['未分类'] += 1;
        else typeCount[t] += 1;
    });
    const typeData = typeOrder
        .filter((name) => typeCount[name] > 0)
        .map((name) => ({ name, value: typeCount[name], itemStyle: { color: typeColors[name] } }));

    const prioCount = { 1: 0, 2: 0, 3: 0 };
    list.forEach((ev) => {
        const p = Number(ev.priority) || 3;
        if (p === 1 || p === 2) prioCount[p] += 1;
        else prioCount[3] += 1;
    });

    const textColor = chartTextColor();
    const axisLine = themeIsDark() ? '#3d4f66' : '#b8c9db';

    if (chartType) {
        chartType.setOption({
            tooltip: { trigger: 'item', formatter: '{b}<br/>{c} 件（{d}%）' },
            legend: {
                orient: 'vertical',
                right: 4,
                top: 'middle',
                textStyle: { color: textColor, fontSize: 11 },
                itemWidth: 8,
                itemHeight: 8
            },
            series: [{
                name: '事件类型',
                type: 'pie',
                radius: ['36%', '62%'],
                center: ['36%', '50%'],
                avoidLabelOverlap: true,
                itemStyle: {
                    borderRadius: 0,
                    borderColor: themeIsDark() ? '#1a2332' : '#fff',
                    borderWidth: 2
                },
                label: { color: textColor, fontSize: 11, formatter: '{c}' },
                labelLine: { length: 8, length2: 6, lineStyle: { color: axisLine } },
                data: typeData
            }]
        }, true);
        chartType.resize();
    }

    if (chartPriority) {
        chartPriority.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            grid: { left: 36, right: 12, top: 22, bottom: 24 },
            xAxis: {
                type: 'category',
                data: ['高', '中', '低'],
                axisLabel: { color: textColor, fontSize: 11 },
                axisLine: { lineStyle: { color: axisLine } },
                axisTick: { show: false }
            },
            yAxis: {
                type: 'value',
                minInterval: 1,
                axisLabel: { color: textColor, fontSize: 10 },
                splitLine: { lineStyle: { color: axisLine, type: 'dashed' } },
                axisLine: { show: false }
            },
            series: [{
                name: '事件数',
                type: 'bar',
                barWidth: 28,
                data: [
                    { value: prioCount[1], itemStyle: { color: '#dc2626' } },
                    { value: prioCount[2], itemStyle: { color: '#d97706' } },
                    { value: prioCount[3], itemStyle: { color: '#059669' } }
                ],
                label: {
                    show: true,
                    position: 'top',
                    color: textColor,
                    fontWeight: 700,
                    fontSize: 12
                }
            }]
        }, true);
        chartPriority.resize();
    }
}

function personDisplayName(u) {
    const name = (u && (u.display_name || u.volunteer_name || u.name || u.username)) || '未命名';
    return String(name).trim() || '未命名';
}

const STATUS_TEXT = {
    1: '待命', 2: '不可用', 3: '响应中', 4: '到达现场', 5: '紧急报警', 6: '离线'
};

const ACTION_LABEL = {
    public_report: '外部上报',
    add_event: '创建事件',
    update_event: '修改事件',
    assign_event: '指派人员（待确认）',
    batch_assign_event: '批量指派（待确认）',
    unassign_event: '取消指派',
    accept_assign: '接受指派',
    reject_assign: '拒绝指派',
    complete_event: '结案完成',
    reopen_event: '重新打开',
    change_status: '状态变更',
    arrive_scene: '到达现场',
    stop_responding: '停止响应',
    event_created: '事件创建',
    sla_warn: 'SLA 预告',
    sla_timeout: 'SLA 超时'
};

function formatDate(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatClockTime(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseReportTypeFromDescription(description) {
    const text = String(description || '');
    const m = text.match(/^【([^】]+)】/);
    if (m) {
        if (['医疗事件求助', '安全问题求助', '其他问题求助'].includes(m[1])) return m[1];
        if (m[1] === '外部上报') return '其他问题求助';
    }
    if (text.includes('【外部上报】')) return '其他问题求助';
    return '';
}

function reportTypeBadgeHtml(reportType) {
    if (!reportType) return '';
    return `<span class="dw-badge dw-badge-type">${escapeHtml(reportType)}</span>`;
}

function priorityBadgeHtml(priority) {
    const p = Number(priority);
    if (p === 1) return '<span class="dw-badge dw-badge-high">高优先级</span>';
    if (p === 2) return '<span class="dw-badge dw-badge-mid">中优先级</span>';
    return '<span class="dw-badge dw-badge-low">低优先级</span>';
}

async function loadAgencySettings() {
    try {
        const res = await fetch('/api/system-settings', { credentials: 'same-origin' });
        const data = await res.json();
        if (data && data.success && data.settings && data.settings.rms) {
            const raw = data.settings.rms.agency_list || '';
            agencyListFromSettings = String(raw)
                .split(/[\n\r,，;；]+/)
                .map((s) => s.trim())
                .filter(Boolean);
            renderAgencyFilterBar(
                (latestDashboardUsers || []).filter((u) => u.status !== 6 && u.status != null)
            );
        }
    } catch (e) {
        console.log('分区设置读取失败', e && e.message ? e.message : e);
    }
}

function renderAgencyFilterBar(visibleUsers) {
    const bar = document.getElementById('personnel-agency-filters');
    if (!bar) return;

    const fromUsers = [];
    (visibleUsers || []).forEach((u) => {
        const a = String(u.agency || '').trim();
        if (a && fromUsers.indexOf(a) === -1) fromUsers.push(a);
    });
    const names = agencyListFromSettings.slice();
    fromUsers.forEach((a) => {
        if (names.indexOf(a) === -1) names.push(a);
    });

    const hasUnassigned = (visibleUsers || []).some((u) => !String(u.agency || '').trim());
    const chips = [
        { value: '', label: '全部' },
        ...names.map((n) => ({ value: n, label: n })),
        ...(hasUnassigned ? [{ value: '__none__', label: '未分区' }] : [])
    ];

    if (agencyFilter && agencyFilter !== '__none__' && names.indexOf(agencyFilter) === -1) {
        agencyFilter = '';
    }
    if (agencyFilter === '__none__' && !hasUnassigned) agencyFilter = '';

    bar.innerHTML = chips.map((c) => {
        const active = agencyFilter === c.value;
        return `<button type="button" data-agency="${escapeHtml(c.value)}" class="agency-filter-btn${active ? ' is-active' : ''}">${escapeHtml(c.label)}</button>`;
    }).join('');
}

function bindDisplayUi() {
    const bar = document.getElementById('personnel-agency-filters');
    if (bar && !bar._agencyBound) {
        bar._agencyBound = true;
        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('.agency-filter-btn');
            if (!btn) return;
            agencyFilter = btn.getAttribute('data-agency') || '';
            renderDashboard(latestDashboardUsers, latestDashboardEvents);
        });
    }

    const scopeTabs = document.getElementById('chart-scope-tabs');
    if (scopeTabs && !scopeTabs._scopeBound) {
        scopeTabs._scopeBound = true;
        scopeTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.dw-scope-tab');
            if (!btn) return;
            setChartScope(btn.getAttribute('data-scope') || 'active', true);
        });
    }

    const btnClose = document.getElementById('btn-close-event-drawer');
    const backdrop = document.getElementById('drawer-event-backdrop');
    if (btnClose) btnClose.addEventListener('click', closeEventDrawer);
    if (backdrop) backdrop.addEventListener('click', closeEventDrawer);
}

function closeEventDrawer() {
    openEventDetailId = null;
    const drawer = document.getElementById('drawer-event-detail');
    if (drawer) {
        drawer.classList.add('hidden');
        drawer.setAttribute('aria-hidden', 'true');
    }
}

async function openEventDetail(eventId) {
    const id = parseInt(eventId, 10);
    if (!id) return;
    openEventDetailId = id;
    const drawer = document.getElementById('drawer-event-detail');
    const body = document.getElementById('ed-body');
    const titleEl = document.getElementById('ed-title');
    if (!drawer || !body) return;
    drawer.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    if (titleEl) titleEl.textContent = '加载中…';
    body.innerHTML = '<div class="text-center text-gray-400 py-10">加载中…</div>';
    await refreshOpenEventDrawer();
}

async function refreshOpenEventDrawer() {
    if (!openEventDetailId) return;
    const body = document.getElementById('ed-body');
    const titleEl = document.getElementById('ed-title');
    if (!body) return;
    try {
        const url = (window.Platform && window.Platform.api)
            ? window.Platform.api('/api/events/' + encodeURIComponent(openEventDetailId))
            : ('/api/events/' + encodeURIComponent(openEventDetailId));
        const res = await fetch(url, { credentials: 'same-origin' });
        const raw = await res.text();
        let data = null;
        try {
            data = raw ? JSON.parse(raw) : null;
        } catch (_) {
            body.innerHTML = `<div class="text-center text-red-500 py-8 text-xs px-3">事件详情加载失败</div>`;
            if (titleEl) titleEl.textContent = '读取失败';
            return;
        }
        if (!data || !data.success || !data.event) {
            body.innerHTML = `<div class="text-center text-amber-600 py-8">${escapeHtml((data && data.message) || '读取失败')}</div>`;
            return;
        }
        renderEventDrawer(data);
    } catch (err) {
        console.error('[display event detail]', err);
        if (titleEl) titleEl.textContent = '读取失败';
        body.innerHTML = '<div class="text-center text-red-500 py-8">事件详情加载失败</div>';
    }
}

function renderEventDrawer(data) {
    const ev = data.event;
    const titleEl = document.getElementById('ed-title');
    const body = document.getElementById('ed-body');
    if (titleEl) titleEl.textContent = ev.title || ('事件 #' + ev.id);

    const priorityBadge = Number(ev.priority) === 1
        ? '<span class="text-xs bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded">高优先级</span>'
        : (Number(ev.priority) === 2
            ? '<span class="text-xs bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded">中优先级</span>'
            : '<span class="text-xs bg-green-100 text-green-700 font-bold px-2 py-0.5 rounded">低优先级</span>');
    const statusBadge = ev.status === '已完成'
        ? '<span class="text-xs bg-gray-200 text-gray-700 font-bold px-2 py-0.5 rounded">已完成</span>'
        : '<span class="text-xs bg-blue-100 text-blue-700 font-bold px-2 py-0.5 rounded">进行中</span>';

    const personnel = data.personnel || [];
    const personnelHtml = personnel.length
        ? personnel.map((p) => {
            const st = STATUS_TEXT[p.status] || ('状态' + p.status);
            return `<div class="flex justify-between items-center gap-2 py-2 border-b border-gray-100 last:border-0">
                <div class="min-w-0">
                    <div class="font-semibold text-gray-800 text-base truncate">${escapeHtml(p.display_name)}</div>
                </div>
                <div class="text-sm text-gray-600 shrink-0">${escapeHtml(st)}</div>
            </div>`;
        }).join('')
        : '<div class="text-gray-400 text-sm py-2">暂无关联人员</div>';

    const timeline = data.timeline || [];
    const timelineHtml = timeline.length
        ? timeline.map((log, idx) => {
            const label = ACTION_LABEL[log.action] || log.action || '操作';
            const actor = log.actor_username || (log.actor_user_id ? ('#' + log.actor_user_id) : '系统');
            return `<div class="relative pl-5 pb-4 last:pb-0">
                <div class="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-[#0056b3] border-2 border-white shadow"></div>
                ${idx < timeline.length - 1 ? '<div class="absolute left-[4px] top-4 bottom-0 w-px bg-blue-100"></div>' : ''}
                <div class="text-[11px] text-gray-400 font-mono">${escapeHtml(formatDate(log.created_at))}</div>
                <div class="mt-0.5"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">${escapeHtml(label)}</span></div>
                <div class="text-sm text-gray-800 mt-1 font-medium">${escapeHtml(log.summary || label)}</div>
                <div class="text-[11px] text-gray-500 mt-0.5">操作人：${escapeHtml(actor)}</div>
            </div>`;
        }).join('')
        : '<div class="text-gray-400 text-sm py-2">暂无时间线记录</div>';

    const remarkText = ev.remark != null ? String(ev.remark) : '';

    body.innerHTML = `
        <section>
            <div class="flex flex-wrap items-center gap-2 mb-3">
                ${statusBadge}
                ${priorityBadge}
                ${ev.report_type ? reportTypeBadgeHtml(ev.report_type) : ''}
            </div>
            <dl class="grid grid-cols-1 gap-3 text-sm">
                <div>
                    <dt class="text-[11px] text-gray-400 font-semibold">事件地点</dt>
                    <dd class="text-gray-800 font-medium mt-0.5 break-all text-base">${escapeHtml(ev.title || '未填写')}</dd>
                </div>
                <div>
                    <dt class="text-[11px] text-gray-400 font-semibold">联系人 / 联系方式</dt>
                    <dd class="text-gray-800 font-medium mt-0.5 break-all">${escapeHtml(ev.contact || '未填写')}</dd>
                </div>
                <div>
                    <dt class="text-[11px] text-gray-400 font-semibold">详细情况</dt>
                    <dd class="text-gray-800 mt-0.5 whitespace-pre-wrap leading-relaxed">${escapeHtml(ev.details || '无')}</dd>
                </div>
                <div>
                    <dt class="text-[11px] text-gray-400 font-semibold">备注</dt>
                    <dd class="text-gray-800 mt-0.5 whitespace-pre-wrap leading-relaxed">${escapeHtml(remarkText || '无')}</dd>
                </div>
                <div class="grid grid-cols-2 gap-3 text-[11px] text-gray-500 font-mono">
                    <div><span class="text-gray-400">创建</span><br>${escapeHtml(formatDate(ev.created_at))}</div>
                    <div><span class="text-gray-400">完成</span><br>${escapeHtml(ev.completed_at ? formatDate(ev.completed_at) : '—')}</div>
                </div>
            </dl>
        </section>
        <section>
            <h4 class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2 border-b pb-2">关联人员</h4>
            <div>${personnelHtml}</div>
        </section>
        <section>
            <h4 class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3 border-b pb-2">操作时间线</h4>
            <div class="relative">${timelineHtml}</div>
        </section>
    `;
}

function statusClass(status) {
    if (status === 1) return 'dw-status-standby';
    if (status === 2) return 'dw-status-off';
    if (status === 3) return 'dw-status-busy';
    if (status === 4) return 'dw-status-scene';
    if (status === 5) return 'dw-status-emergency';
    return 'dw-status-off';
}

function renderDashboard(users, events) {
    latestDashboardUsers = users || [];
    latestDashboardEvents = events || [];

    const visibleUsers = users.filter((u) => u.status !== 6 && u.status !== null && u.status !== undefined);
    const onlineCount = visibleUsers.filter((u) => u.status !== 2).length;
    const availableCount = visibleUsers.filter((u) => u.status === 1).length;
    const busyCount = visibleUsers.filter((u) => u.status === 3 || u.status === 4).length;
    const activeEvents = events.filter((ev) => ev.status === '未完成');
    const completedEvents = events.filter((ev) => ev.status === '已完成');

    const onlineEl = document.getElementById('stat-online-users');
    const availEl = document.getElementById('stat-available-users');
    const busyEl = document.getElementById('stat-busy-users');
    const activeEl = document.getElementById('stat-active-events');
    if (onlineEl) onlineEl.innerText = onlineCount;
    if (availEl) availEl.innerText = availableCount;
    if (busyEl) busyEl.innerText = busyCount;
    if (activeEl) activeEl.innerText = activeEvents.length;

    renderEventCharts(events);
    renderAgencyFilterBar(visibleUsers);

    let filteredUsers = visibleUsers;
    if (agencyFilter === '__none__') {
        filteredUsers = visibleUsers.filter((u) => !String(u.agency || '').trim());
    } else if (agencyFilter) {
        filteredUsers = visibleUsers.filter((u) => String(u.agency || '').trim() === agencyFilter);
    }

    const sortedUsers = [...filteredUsers].sort((a, b) => {
        const rank = (s) => (s === 5 ? 0 : s === 4 ? 1 : s === 3 ? 2 : s === 1 ? 3 : 4);
        return rank(a.status) - rank(b.status);
    });
    const personnelListEl = document.getElementById('personnel-list');
    if (!personnelListEl) return;

    if (!sortedUsers.length) {
        personnelListEl.innerHTML = '<div class="dw-empty">当前分区暂无人员</div>';
    } else {
        personnelListEl.innerHTML = sortedUsers.map((u) => {
            let eventInfo = '';
            if ((u.status === 3 || u.status === 4) && u.event_title) {
                eventInfo = `<div class="dw-person-event">响应：${escapeHtml(u.event_title)}</div>`;
            } else if (u.pending_event_id && u.pending_event_title) {
                eventInfo = `<div class="dw-person-event is-pending">待确认：${escapeHtml(u.pending_event_title)}</div>`;
            }
            const displayName = personDisplayName(u);
            const agencyLabel = String(u.agency || '').trim();
            const st = STATUS_TEXT[u.status] || '未知';

            return `
                <div class="dw-person${u.status === 5 ? ' is-emergency' : ''}">
                    <div class="min-w-0 flex-1">
                        <div class="dw-person-name">${escapeHtml(displayName)}</div>
                        ${agencyLabel ? `<div class="dw-person-meta">${escapeHtml(agencyLabel)}</div>` : ''}
                        ${eventInfo}
                    </div>
                    <div class="dw-status ${statusClass(u.status)}">${escapeHtml(st)}</div>
                </div>
            `;
        }).join('');
    }

    const eventsListEl = document.getElementById('admin-events-list');
    if (eventsListEl) {
        if (activeEvents.length === 0) {
            eventsListEl.innerHTML = '<div class="dw-empty">暂无进行中事件</div>';
        } else {
            const sortedActive = [...activeEvents].sort((a, b) => Number(a.priority || 9) - Number(b.priority || 9));
            eventsListEl.innerHTML = sortedActive.map((ev) => {
                const reportType = parseReportTypeFromDescription(ev.description || '');
                return `
                    <div class="dw-event${reportType ? ' is-report' : ''}" onclick="openEventDetail(${ev.id})" title="查看详情">
                        <div class="dw-event-title">${escapeHtml(ev.title)}</div>
                        <div class="dw-event-badges">
                            ${priorityBadgeHtml(ev.priority)}
                            ${reportTypeBadgeHtml(reportType)}
                        </div>
                        <div class="dw-event-desc">${escapeHtml(ev.description || '无描述')}</div>
                        <div class="dw-event-time">${formatDate(ev.created_at)}</div>
                    </div>
                `;
            }).join('');
        }
    }

    const completedListEl = document.getElementById('admin-completed-events-list');
    if (completedListEl) {
        if (completedEvents.length === 0) {
            completedListEl.innerHTML = '<div class="dw-empty">暂无已完成</div>';
        } else {
            completedListEl.innerHTML = completedEvents.map((ev) => `
                <div class="dw-event is-done" onclick="openEventDetail(${ev.id})" title="查看详情">
                    <div class="dw-event-title">${escapeHtml(ev.title)}</div>
                    <div class="dw-event-time">完成 ${formatClockTime(ev.completed_at)}</div>
                </div>
            `).join('');
        }
    }
}
