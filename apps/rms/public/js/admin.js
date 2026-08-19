let currentUser = null;
let socket = null;
let allEvents = [];
let allUsers = [];
let agencyFilter = '';
let agencyListFromSettings = [];
let latestDashboardUsers = [];
let latestDashboardEvents = [];
let slaDashboardReady = false;

document.addEventListener('DOMContentLoaded', async () => {
    loadSlaAckState();
    const res = await fetch('/api/me');
    const data = await res.json();
    if (!data.success || data.user.role !== 'admin') {
        window.location.href = '/login.php?redirect=' + encodeURIComponent('/rms/dispatch.html');
        return;
    }
    currentUser = data.user;

    initHeader(currentUser);
    await Promise.all([loadSlaSettings(), loadAgencySettings()]);

    socket = io(window.Platform ? window.Platform.ioOptions() : { path: '/rms/socket.io' });
    initEmergencyListener(socket);

    socket.on('data_updated', (payload) => {
        allUsers = payload.users || [];
        allEvents = payload.events || [];
        slaDashboardReady = true;
        renderDashboard(payload.users, payload.events);
        if (openEventDetailId && !eventDrawerUnlocked) refreshOpenEventDrawer();
        stopSlaIfArrivedOnScene();
        evaluateSlaAlerts();
        const bcModal = document.getElementById('modal-broadcast');
        if (bcModal && !bcModal.classList.contains('hidden')) {
            renderBroadcastScopeChips();
            syncBroadcastUserPickVisibility();
            updateBroadcastPreview();
        }
    });

    socket.on('public_report_alert', (payload) => {
        showPublicReportModal(payload);
    });

    bindAdminActions();
    bindAgencyFilterButtons();
    setInterval(() => {
        loadSlaSettings();
        loadAgencySettings();
        evaluateSlaAlerts();
    }, 15000);
});

let openEventDetailId = null;
let eventDrawerUnlocked = false;
let lastEventDrawerData = null;

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

function normalizeEventDrawerFields(ev) {
    const contact = (ev.contact && ev.contact !== '未填写') ? String(ev.contact) : '';
    const details = (ev.details && ev.details !== '无') ? String(ev.details) : '';
    return {
        title: String(ev.title || '').trim(),
        contact: contact.trim(),
        details: details.trim(),
        remark: String(ev.remark != null ? ev.remark : '').trim(),
        priority: String(Number(ev.priority) || 3)
    };
}

function getEventDrawerFormValues() {
    const titleEl = document.getElementById('ed-edit-title');
    const contactEl = document.getElementById('ed-edit-contact');
    const detailsEl = document.getElementById('ed-edit-details');
    const priorityEl = document.getElementById('ed-edit-priority');
    const remarkEl = document.getElementById('ed-edit-remark');
    if (!titleEl || !contactEl || !detailsEl || !priorityEl) return null;
    return {
        title: titleEl.value.trim(),
        contact: contactEl.value.trim(),
        details: detailsEl.value.trim(),
        remark: remarkEl ? remarkEl.value.trim() : '',
        priority: String(parseInt(priorityEl.value, 10) || 3)
    };
}

function isEventDrawerDirty() {
    if (!eventDrawerUnlocked || !lastEventDrawerData || !lastEventDrawerData.event) return false;
    const cur = getEventDrawerFormValues();
    if (!cur) return false;
    const base = normalizeEventDrawerFields(lastEventDrawerData.event);
    return cur.title !== base.title
        || cur.contact !== base.contact
        || cur.details !== base.details
        || cur.remark !== base.remark
        || cur.priority !== base.priority;
}

function updateEventDrawerSaveVisibility() {
    const btn = document.getElementById('btn-save-event-drawer');
    if (!btn) return;
    btn.classList.toggle('hidden', !isEventDrawerDirty());
}

function syncEventDrawerLockButton(canEdit) {
    const btn = document.getElementById('btn-toggle-event-lock');
    if (!btn) return;
    if (!canEdit) {
        btn.classList.add('hidden');
        btn.onclick = null;
        return;
    }
    btn.classList.remove('hidden');
    btn.textContent = eventDrawerUnlocked ? '锁定' : '解锁';
    btn.onclick = () => toggleEventDrawerLock();
}

function toggleEventDrawerLock() {
    if (!lastEventDrawerData || !lastEventDrawerData.event) return;
    if (lastEventDrawerData.event.status !== '未完成') return;
    if (eventDrawerUnlocked) {
        if (isEventDrawerDirty() && !confirm('有未保存的修改，锁定将丢弃修改。确定锁定？')) return;
        eventDrawerUnlocked = false;
    } else {
        eventDrawerUnlocked = true;
    }
    renderEventDrawer(lastEventDrawerData);
}

function bindEventDrawerDirtyWatch() {
    ['ed-edit-title', 'ed-edit-contact', 'ed-edit-details', 'ed-edit-remark', 'ed-edit-priority'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', updateEventDrawerSaveVisibility);
        el.addEventListener('change', updateEventDrawerSaveVisibility);
    });
    updateEventDrawerSaveVisibility();
}

function closeEventDrawer() {
    openEventDetailId = null;
    eventDrawerUnlocked = false;
    lastEventDrawerData = null;
    syncEventDrawerLockButton(false);
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
    eventDrawerUnlocked = false;
    const drawer = document.getElementById('drawer-event-detail');
    const body = document.getElementById('ed-body');
    const titleEl = document.getElementById('ed-title');
    if (!drawer || !body) return;
    drawer.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    if (titleEl) titleEl.textContent = '加载中…';
    body.innerHTML = '<div class="text-center text-gray-400 py-10">加载中…</div>';
    syncEventDrawerLockButton(false);
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
            body.innerHTML = `<div class="text-center text-red-500 py-8 text-xs px-3">事件详情加载失败（HTTP ${res.status}，返回非 JSON）<br><span class="text-gray-400 break-all">${escapeHtml(String(raw).slice(0, 180))}</span></div>`;
            if (titleEl) titleEl.textContent = '读取失败';
            syncEventDrawerLockButton(false);
            return;
        }
        if (!data || !data.success || !data.event) {
            body.innerHTML = `<div class="text-center text-amber-600 py-8">${escapeHtml((data && data.message) || ('读取失败 HTTP ' + res.status))}</div>`;
            syncEventDrawerLockButton(false);
            return;
        }
        renderEventDrawer(data);
    } catch (err) {
        console.error('[event detail]', err);
        if (titleEl) titleEl.textContent = '读取失败';
        body.innerHTML = `<div class="text-center text-red-500 py-8">事件详情加载失败<br><span class="text-xs text-gray-500">${escapeHtml(err && err.message ? err.message : '')}</span></div>`;
        syncEventDrawerLockButton(false);
    }
}

function renderEventDrawer(data) {
    const ev = data.event;
    lastEventDrawerData = data;
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
            const tag = p.is_primary_responder
                ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 ml-1">主指派</span>'
                : '';
            return `<div class="flex justify-between items-center gap-2 py-2 border-b border-gray-100 last:border-0">
                <div class="min-w-0">
                    <div class="font-semibold text-gray-800 text-sm truncate">${escapeHtml(p.display_name)}${tag}</div>
                    <div class="text-[11px] text-gray-400">${escapeHtml(p.username || '')}</div>
                </div>
                <div class="text-xs text-gray-600 shrink-0">${escapeHtml(st)}</div>
            </div>`;
        }).join('')
        : '<div class="text-gray-400 text-xs py-2">暂无关联人员</div>';

    const timeline = data.timeline || [];
    const timelineHtml = timeline.length
        ? timeline.map((log, idx) => {
            const label = ACTION_LABEL[log.action] || log.action || '操作';
            const actor = log.actor_username || (log.actor_user_id ? ('#' + log.actor_user_id) : '系统');
            const target = log.target_username ? ` → ${log.target_username}` : '';
            return `<div class="relative pl-5 pb-4 last:pb-0">
                <div class="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-[#0056b3] border-2 border-white shadow"></div>
                ${idx < timeline.length - 1 ? '<div class="absolute left-[4px] top-4 bottom-0 w-px bg-blue-100"></div>' : ''}
                <div class="text-[11px] text-gray-400 font-mono">${escapeHtml(formatDate(log.created_at))}</div>
                <div class="mt-0.5">
                    <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">${escapeHtml(label)}</span>
                </div>
                <div class="text-sm text-gray-800 mt-1 font-medium">${escapeHtml(log.summary || label)}</div>
                <div class="text-[11px] text-gray-500 mt-0.5">操作人：${escapeHtml(actor)}${escapeHtml(target)}</div>
            </div>`;
        }).join('')
        : '<div class="text-gray-400 text-xs py-2">暂无时间线记录</div>';

    const canEdit = ev.status === '未完成';
    if (!canEdit) eventDrawerUnlocked = false;
    const fields = normalizeEventDrawerFields(ev);
    const remarkText = fields.remark;

    let infoSection;
    if (canEdit && eventDrawerUnlocked) {
        infoSection = `<section class="space-y-3">
            <div class="flex flex-wrap items-center gap-2 mb-1">
                ${statusBadge}
                ${ev.report_type ? reportTypeBadgeHtml(ev.report_type) : ''}
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">${escapeHtml(ev.source || '未知来源')}</span>
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">编辑中</span>
            </div>
            <div>
                <label class="block text-[11px] text-gray-400 font-semibold mb-1" for="ed-edit-title">事件地点</label>
                <input type="text" id="ed-edit-title" value="${escapeHtml(fields.title)}" class="w-full p-2.5 border rounded-lg text-sm" placeholder="如：中山区某某路交叉口">
            </div>
            <div>
                <label class="block text-[11px] text-gray-400 font-semibold mb-1" for="ed-edit-contact">联系方式</label>
                <input type="text" id="ed-edit-contact" value="${escapeHtml(fields.contact)}" class="w-full p-2.5 border rounded-lg text-sm" placeholder="如：13800138000">
            </div>
            <div>
                <label class="block text-[11px] text-gray-400 font-semibold mb-1" for="ed-edit-details">详细情况</label>
                <textarea id="ed-edit-details" rows="3" class="w-full p-2.5 border rounded-lg text-sm" placeholder="伤情、人数、现场情况等…">${escapeHtml(fields.details)}</textarea>
            </div>
            <div>
                <label class="block text-[11px] text-gray-400 font-semibold mb-1" for="ed-edit-priority">优先级</label>
                <select id="ed-edit-priority" class="w-full p-2.5 border rounded-lg text-sm">
                    <option value="1"${fields.priority === '1' ? ' selected' : ''}>高优先级</option>
                    <option value="2"${fields.priority === '2' ? ' selected' : ''}>中优先级</option>
                    <option value="3"${fields.priority !== '1' && fields.priority !== '2' ? ' selected' : ''}>低优先级</option>
                </select>
            </div>
            <div>
                <label class="block text-[11px] text-gray-400 font-semibold mb-1" for="ed-edit-remark">备注</label>
                <textarea id="ed-edit-remark" rows="2" class="w-full p-2.5 border rounded-lg text-sm" placeholder="调度备注（可选）">${escapeHtml(remarkText)}</textarea>
            </div>
            <div class="grid grid-cols-2 gap-3 text-[11px] text-gray-500 font-mono">
                <div><span class="text-gray-400">创建</span><br>${escapeHtml(formatDate(ev.created_at))}</div>
                <div><span class="text-gray-400">完成</span><br>${escapeHtml(ev.completed_at ? formatDate(ev.completed_at) : '—')}</div>
            </div>
            <button type="button" id="btn-save-event-drawer" onclick="saveEventFromDrawer(${Number(ev.id)})"
                class="hidden w-full py-2.5 bg-[#0056b3] hover:bg-[#004494] text-white font-semibold rounded-xl text-sm shadow">
                保存修改
            </button>
        </section>`;
    } else {
        infoSection = `<section>
            <div class="flex flex-wrap items-center gap-2 mb-3">
                ${statusBadge}
                ${priorityBadge}
                ${ev.report_type ? reportTypeBadgeHtml(ev.report_type) : ''}
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">${escapeHtml(ev.source || '未知来源')}</span>
            </div>
            <dl class="grid grid-cols-1 gap-3 text-sm">
                <div>
                    <dt class="text-[11px] text-gray-400 font-semibold">事件地点</dt>
                    <dd class="text-gray-800 font-medium mt-0.5 break-all">${escapeHtml(ev.title || '未填写')}</dd>
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
                <div>
                    <dt class="text-[11px] text-gray-400 font-semibold">来源</dt>
                    <dd class="text-gray-800 font-medium mt-0.5">${escapeHtml(ev.source || '—')}</dd>
                </div>
                <div class="grid grid-cols-2 gap-3 text-[11px] text-gray-500 font-mono">
                    <div><span class="text-gray-400">创建</span><br>${escapeHtml(formatDate(ev.created_at))}</div>
                    <div><span class="text-gray-400">完成</span><br>${escapeHtml(ev.completed_at ? formatDate(ev.completed_at) : '—')}</div>
                </div>
            </dl>
        </section>`;
    }

    body.innerHTML = `
        ${infoSection}

        <section>
            <h4 class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2 border-b pb-2">关联人员</h4>
            <div>${personnelHtml}</div>
        </section>

        <section>
            <h4 class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3 border-b pb-2">操作时间线</h4>
            <div class="relative">${timelineHtml}</div>
        </section>
    `;

    syncEventDrawerLockButton(canEdit);
    if (canEdit && eventDrawerUnlocked) bindEventDrawerDirtyWatch();
}

function saveEventFromDrawer(eventId) {
    const id = parseInt(eventId, 10);
    const cur = getEventDrawerFormValues();
    if (!id || !cur) {
        alert('编辑表单未就绪，请关闭后重新打开事件详情');
        return;
    }
    if (!cur.title || !cur.contact || !cur.details) {
        alert('请填写事件地点、联系方式和详细情况');
        return;
    }
    if (!isEventDrawerDirty()) return;
    if (!socket) {
        alert('未连接服务器，请刷新后重试');
        return;
    }
    socket.emit('update_event', {
        eventId: id,
        title: cur.title,
        contact: cur.contact,
        details: cur.details,
        remark: cur.remark,
        priority: parseInt(cur.priority, 10) || 3
    });
    eventDrawerUnlocked = false;
    setTimeout(() => {
        if (openEventDetailId === id) refreshOpenEventDrawer();
    }, 200);
}

function formatDate(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderDashboard(users, events) {
    latestDashboardUsers = users || [];
    latestDashboardEvents = events || [];

    const visibleUsers = users.filter(u => u.status !== 6 && u.status !== null && u.status !== undefined);

    const onlineCount = visibleUsers.filter(u => u.status !== 2).length;
    const availableCount = visibleUsers.filter(u => u.status === 1).length;

    const activeEvents = events.filter(ev => ev.status === '未完成');
    const completedEvents = events.filter(ev => ev.status === '已完成');

    document.getElementById('stat-online-users').innerText = onlineCount;
    document.getElementById('stat-available-users').innerText = availableCount;
    document.getElementById('stat-active-events').innerText = activeEvents.length;

    renderAgencyFilterBar(visibleUsers);

    let filteredUsers = visibleUsers;
    if (agencyFilter === '__none__') {
        filteredUsers = visibleUsers.filter((u) => !String(u.agency || '').trim());
    } else if (agencyFilter) {
        filteredUsers = visibleUsers.filter((u) => String(u.agency || '').trim() === agencyFilter);
    }

    const sortedUsers = [...filteredUsers].sort((a, b) => (b.status === 5 ? 1 : 0) - (a.status === 5 ? 1 : 0));
    const personnelListEl = document.getElementById('personnel-list');

    const statusTagMap = {
        1: '<span class="dc-status dc-status-standby">待命</span>',
        2: '<span class="dc-status dc-status-off">不可用</span>',
        3: '<span class="dc-status dc-status-busy">响应中</span>',
        4: '<span class="dc-status dc-status-scene">到达现场</span>',
        5: '<span class="dc-status dc-status-emergency animate-pulse">紧急</span>',
        6: '<span class="dc-status dc-status-offline">离线</span>'
    };

    if (!sortedUsers.length) {
        personnelListEl.innerHTML = '<div class="dc-empty">当前分区下暂无人员</div>';
    } else {
    personnelListEl.innerHTML = sortedUsers.map(u => {
        const cardClass = (u.status === 5) ? 'emergency-highlight' : 'dc-row';
        let eventInfo = '';
        if ((u.status === 3 || u.status === 4) && u.event_title) {
            eventInfo = `<div class="text-[11px] text-sky-300 font-medium mt-0.5">当前响应：${escapeHtml(u.event_title)}</div>`;
        } else if (u.pending_event_id && u.pending_event_title) {
            eventInfo = `<div class="text-[11px] text-amber-300 font-medium mt-0.5">待确认指派：${escapeHtml(u.pending_event_title)}</div>`;
        }
        const displayName = personDisplayName(u);
        const agencyLabel = String(u.agency || '').trim();
        const canCancel = !!(u.current_event_id || u.pending_event_id);

        return `
            <div class="px-2.5 py-2 flex justify-between items-center gap-2 ${cardClass}">
                <div class="min-w-0 flex-1 cursor-pointer rounded-sm -m-0.5 p-0.5 transition"
                     data-action="open-certs" data-user-id="${Number(u.id) || 0}"
                     title="点击查看详细信息">
                    <div class="dc-name font-semibold text-sm flex items-center gap-2 flex-wrap">
                        ${escapeHtml(displayName)}
                        <span class="dc-meta text-xs font-normal">(${escapeHtml(u.role)})</span>
                        ${agencyLabel ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-sm bg-slate-700/80 text-slate-200">${escapeHtml(agencyLabel)}</span>` : ''}
                    </div>
                    ${eventInfo}
                </div>
                <div class="flex items-center gap-1.5 shrink-0 dc-person-actions">
                    ${canCancel ? `
                    <button type="button" data-action="unassign" data-user-id="${Number(u.id) || 0}" data-name="${escapeHtml(displayName)}" class="dc-btn dc-btn-cancel">
                        取消指派
                    </button>` : ''}
                    <button type="button" data-action="assign" data-user-id="${Number(u.id) || 0}" data-name="${escapeHtml(displayName)}" class="dc-btn dc-btn-assign">
                        指派
                    </button>
                    <div>${statusTagMap[u.status] || statusTagMap[2]}</div>
                </div>
            </div>
        `;
    }).join('');
    }

    const eventsListEl = document.getElementById('admin-events-list');
    if (activeEvents.length === 0) {
        eventsListEl.innerHTML = '<div class="dc-empty">暂无进行中的事件</div>';
    } else {
        eventsListEl.innerHTML = activeEvents.map(ev => {
            const reportType = parseReportTypeFromDescription(ev.description || '');
            const priorityBadge = ev.priority === 1 ? '<span class="dc-priority dc-priority-high">高</span>' :
                                    (ev.priority === 2 ? '<span class="dc-priority dc-priority-mid">中</span>' :
                                                         '<span class="dc-priority dc-priority-low">低</span>');
            return `
                <div class="dc-row px-2.5 py-2 flex justify-between items-start gap-2 cursor-pointer ${reportType ? 'border-l-2 border-l-amber-500' : ''}"
                     onclick="openEventDetail(${ev.id})" title="点击查看事件详情">
                    <div class="pr-2 min-w-0 flex-1">
                        <div class="dc-name font-semibold text-sm flex flex-wrap items-center gap-1.5">${escapeHtml(ev.title)} ${reportTypeBadgeHtml(reportType)} ${priorityBadge}</div>
                        <div class="dc-desc text-xs mt-1 whitespace-pre-wrap line-clamp-3">${escapeHtml(ev.description || '无描述')}</div>
                        <div class="dc-time text-[11px] mt-1 font-mono">创建 ${formatDate(ev.created_at)}</div>
                    </div>
                    <div class="flex flex-col gap-1.5 shrink-0" onclick="event.stopPropagation()">
                        <button onclick="openBatchAssignModal(${ev.id})" class="dc-btn dc-btn-batch whitespace-nowrap">
                            批量指派
                        </button>
                        <button onclick="completeEvent(${ev.id})" class="dc-btn dc-btn-done whitespace-nowrap">
                            标记完成
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    const completedListEl = document.getElementById('admin-completed-events-list');
    if (completedListEl) {
        if (completedEvents.length === 0) {
            completedListEl.innerHTML = '<div class="dc-empty">暂无已完成的事件</div>';
        } else {
            completedListEl.innerHTML = completedEvents.map(ev => {
                return `
                    <div class="dc-row px-2.5 py-2 flex justify-between items-center gap-2 opacity-90 cursor-pointer"
                         onclick="openEventDetail(${ev.id})" title="点击查看事件详情">
                        <div class="pr-2 min-w-0">
                            <div class="dc-name font-semibold text-sm line-through opacity-80">${escapeHtml(ev.title)}</div>
                            <div class="dc-desc text-xs mt-1 line-clamp-2">${escapeHtml(ev.description || '无描述')}</div>
                            <div class="dc-time text-[11px] mt-1 font-mono space-y-0.5">
                                <div>创建 ${formatDate(ev.created_at)}</div>
                                <div>完成 ${formatDate(ev.completed_at)}</div>
                            </div>
                        </div>
                        <button onclick="event.stopPropagation(); reopenEvent(${ev.id})" class="dc-btn dc-btn-reopen whitespace-nowrap shrink-0">
                            取消完成
                        </button>
                    </div>
                `;
            }).join('');
        }
    }
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
    const color =
        reportType === '医疗事件求助' ? 'bg-red-100 text-red-700' :
        reportType === '安全问题求助' ? 'bg-amber-100 text-amber-700' :
        'bg-slate-100 text-slate-700';
    return `<span class="text-[10px] ${color} font-bold px-1.5 py-0.5 rounded ml-1">${escapeHtml(reportType)}</span>`;
}

function parseDescriptionFields(description) {
    const text = String(description || '');
    let work = text;
    let remark = '';
    const remarkIdx = work.search(/\n备注[：:]/);
    if (remarkIdx >= 0) {
        remark = work.slice(remarkIdx).replace(/^\n备注[：:]\s*/, '').trim();
        work = work.slice(0, remarkIdx);
    }
    const contactMatch = work.match(/联系方式[：:]\s*([^\n\r]*)/);
    const detailsMatch = work.match(/详细情况[：:]\s*([\s\S]*)/);
    if (!contactMatch && !detailsMatch) {
        return {
            contact: '',
            details: work.replace(/【[^】]+】\s*/g, '').replace(/地点[：:][^\n\r]*\s*/g, '').trim(),
            remark,
            report_type: parseReportTypeFromDescription(text)
        };
    }
    return {
        contact: contactMatch ? contactMatch[1].trim() : '',
        details: detailsMatch ? detailsMatch[1].trim() : '',
        remark,
        report_type: parseReportTypeFromDescription(text)
    };
}

function completeEvent(eventId) {
    if (confirm('确认标记此事件为完结状态？')) {
        socket.emit('complete_event', { eventId });
    }
}

function reopenEvent(eventId) {
    if (confirm('确认取消完成状态，重新恢复此事件为进行中？')) {
        socket.emit('reopen_event', { eventId });
    }
}

function unassignEvent(userId, username) {
    if (!confirm('确认取消对「' + username + '」的事件指派？队员将恢复待命。')) return;
    socket.emit('unassign_event', { userId });
}

let pendingPublicReport = null;

function getEventToneAudio() {
    return document.getElementById('event-tone');
}

function startEventToneLoop() {
    const audio = getEventToneAudio();
    if (!audio) return;
    try {
        audio.loop = true;
        audio.currentTime = 0;
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
            p.catch((err) => console.log('event_tone 播放失败', err && err.message ? err.message : err));
        }
    } catch (e) { /* ignore */ }
}

function stopEventToneLoop() {
    const audio = getEventToneAudio();
    if (!audio) return;
    try {
        audio.pause();
        audio.currentTime = 0;
    } catch (e) { /* ignore */ }
}

function resetPublicReportSteps() {
    const alertStep = document.getElementById('pr-step-alert');
    const detailStep = document.getElementById('pr-step-detail');
    if (alertStep) alertStep.classList.remove('hidden');
    if (detailStep) detailStep.classList.add('hidden');
}

function closePublicReportModal() {
    stopEventToneLoop();
    const modal = document.getElementById('modal-public-report');
    if (modal) modal.classList.add('hidden');
    resetPublicReportSteps();
    pendingPublicReport = null;
    setTimeout(() => evaluateSlaAlerts(), 50);
}

function showPublicReportDetail() {
    stopEventToneLoop();
    const alertStep = document.getElementById('pr-step-alert');
    const detailStep = document.getElementById('pr-step-detail');
    if (alertStep) alertStep.classList.add('hidden');
    if (detailStep) detailStep.classList.remove('hidden');
}

function showPublicReportModal(payload) {
    const modal = document.getElementById('modal-public-report');
    if (!modal) return;

    // 外部上报优先：若 SLA 弹窗开着，先停 SLA 音并暂隐（关闭上报后再评估）
    if (isSlaModalOpen()) {
        stopSlaTones();
        const slaModal = document.getElementById('modal-sla-alert');
        if (slaModal) slaModal.classList.add('hidden');
        resetSlaSteps();
        // 不 ack，上报关闭后还会再弹
        pendingSlaAlert = null;
    }

    const parsed = parseDescriptionFields(payload.description || '');
    const title = payload.title || '--';
    const contact = payload.contact || parsed.contact || '--';
    const details = payload.details || parsed.details || '--';
    const reportType = payload.report_type || parsed.report_type || parseReportTypeFromDescription(payload.description || '') || '其他问题求助';

    pendingPublicReport = {
        id: payload.id,
        title: payload.title || '',
        contact: payload.contact || parsed.contact || '',
        details: payload.details || parsed.details || '',
        description: payload.description || '',
        report_type: reportType,
        priority: 3
    };

    const alertTitle = document.getElementById('pr-alert-title');
    if (alertTitle) alertTitle.textContent = title;
    const alertType = document.getElementById('pr-alert-type');
    if (alertType) alertType.textContent = reportType;
    const detailType = document.getElementById('pr-detail-type');
    if (detailType) detailType.textContent = reportType;
    document.getElementById('pr-title').textContent = title;
    document.getElementById('pr-contact').textContent = contact;
    document.getElementById('pr-details').textContent = details;
    const priorityEl = document.getElementById('pr-priority');
    if (priorityEl) priorityEl.value = '3';

    resetPublicReportSteps();
    modal.classList.remove('hidden');
    startEventToneLoop();
}

function savePublicReportPriority() {
    if (!pendingPublicReport || !pendingPublicReport.id) {
        alert('事件信息丢失，请刷新后重试');
        return;
    }
    const priorityEl = document.getElementById('pr-priority');
    const priority = parseInt(priorityEl && priorityEl.value, 10) || 3;
    const { id, title, contact, details } = pendingPublicReport;
    if (!title || !contact || !details) {
        alert('事件信息不完整，无法保存优先级');
        return;
    }
    socket.emit('update_event', {
        eventId: id,
        title,
        contact,
        details,
        priority
    });
    pendingPublicReport.priority = priority;
    alert('优先级已更新');
    closePublicReportModal();
}

/* ========== 事件超时 / SLA 提醒 ========== */
let rmsSlaSettings = null;
let pendingSlaAlert = null;
/** 预告已确认（只一次） */
const slaWarnAcked = new Set();
/** 超时重复=0 时，首次关闭后不再提醒 */
const slaTimeoutDoneOnce = new Set();
/** 超时上次关闭时间（用于重复提醒） eventId -> timestamp */
const slaTimeoutLastAckAt = new Map();
/** 已有人到达现场，永久停止该事件 SLA（至结案清理） */
const slaStoppedByArrive = new Set();
let slaQueue = [];
const SLA_ACK_KEY = 'rms_sla_ack_v1';

function loadSlaAckState() {
    try {
        const raw = localStorage.getItem(SLA_ACK_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return;
        (data.warnAcked || []).forEach((id) => slaWarnAcked.add(String(id)));
        (data.timeoutDoneOnce || []).forEach((id) => slaTimeoutDoneOnce.add(String(id)));
        Object.keys(data.timeoutLastAckAt || {}).forEach((id) => {
            const ts = Number(data.timeoutLastAckAt[id]);
            if (Number.isFinite(ts) && ts > 0) slaTimeoutLastAckAt.set(String(id), ts);
        });
        (data.stoppedByArrive || []).forEach((id) => slaStoppedByArrive.add(String(id)));
    } catch (e) { /* ignore */ }
}

function saveSlaAckState() {
    try {
        const timeoutLastAckAt = {};
        slaTimeoutLastAckAt.forEach((v, k) => { timeoutLastAckAt[String(k)] = v; });
        localStorage.setItem(SLA_ACK_KEY, JSON.stringify({
            warnAcked: Array.from(slaWarnAcked),
            timeoutDoneOnce: Array.from(slaTimeoutDoneOnce),
            timeoutLastAckAt,
            stoppedByArrive: Array.from(slaStoppedByArrive)
        }));
    } catch (e) { /* ignore */ }
}

const SLA_TYPE_KEYS = {
    '医疗事件求助': 'medical',
    '安全问题求助': 'safety',
    '其他问题求助': 'other'
};
const SLA_PRIORITY_KEYS = { 1: 'high', 2: 'mid', 3: 'low' };
const SLA_PRIORITY_LABEL = { 1: '高优先级', 2: '中优先级', 3: '低优先级' };

async function loadSlaSettings() {
    try {
        const res = await fetch('/api/system-settings', { credentials: 'same-origin' });
        const data = await res.json();
        if (data && data.success && data.settings && data.settings.rms) {
            rmsSlaSettings = data.settings.rms;
        }
    } catch (e) {
        console.log('SLA 设置读取失败', e && e.message ? e.message : e);
    }
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
                .filter(Boolean)
                .filter((v, i, arr) => arr.indexOf(v) === i);
            if (latestDashboardUsers.length || latestDashboardEvents.length) {
                renderAgencyFilterBar(
                    (latestDashboardUsers || []).filter((u) => u.status !== 6 && u.status != null)
                );
            }
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

    // 若当前过滤项已不存在，回到全部
    if (agencyFilter && agencyFilter !== '__none__' && names.indexOf(agencyFilter) === -1) {
        agencyFilter = '';
    }
    if (agencyFilter === '__none__' && !hasUnassigned) {
        agencyFilter = '';
    }

    bar.innerHTML = chips.map((c) => {
        const active = agencyFilter === c.value;
        const cls = active
            ? 'agency-filter-btn is-active px-2.5 py-1 text-xs font-bold'
            : 'agency-filter-btn px-2.5 py-1 text-xs font-bold';
        return `<button type="button" data-agency="${escapeHtml(c.value)}" class="${cls}">${escapeHtml(c.label)}</button>`;
    }).join('');
}

function bindAgencyFilterButtons() {
    const bar = document.getElementById('personnel-agency-filters');
    if (!bar || bar._agencyBound) return;
    bar._agencyBound = true;
    bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.agency-filter-btn');
        if (!btn) return;
        agencyFilter = btn.getAttribute('data-agency') || '';
        renderDashboard(latestDashboardUsers, latestDashboardEvents);
    });
}

function resolveEventSla(reportType, priority) {
    const rms = rmsSlaSettings || {};
    const typeKey = SLA_TYPE_KEYS[reportType] || 'other';
    const level = SLA_PRIORITY_KEYS[Number(priority)] || 'low';
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

function eventAgeMinutes(ev) {
    if (!ev || !ev.created_at) return 0;
    const t = new Date(ev.created_at).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, (Date.now() - t) / 60000);
}

function formatElapsedMinutes(mins) {
    const m = Math.floor(mins);
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h + ' 小时 ' + rem + ' 分钟';
}

/** 任意指派到该事件的人员已「到达现场」(status=4) */
function eventHasArrivedOnScene(eventId) {
    const id = Number(eventId);
    if (!id) return false;
    if (slaStoppedByArrive.has(String(id))) return true;
    return (allUsers || []).some((u) =>
        Number(u.current_event_id) === id && Number(u.status) === 4
    );
}

function stopSlaIfArrivedOnScene() {
    // 扫描进行中事件：有人到达则标记停止
    (allEvents || []).forEach((ev) => {
        if (ev.status !== '未完成') return;
        if (eventHasArrivedOnScene(ev.id)) {
            slaStoppedByArrive.add(String(ev.id));
            saveSlaAckState();
        }
    });

    if (pendingSlaAlert && eventHasArrivedOnScene(pendingSlaAlert.eventId)) {
        stopSlaTones();
        const modal = document.getElementById('modal-sla-alert');
        if (modal) modal.classList.add('hidden');
        resetSlaSteps();
        pendingSlaAlert = null;
    }
}

function isPublicReportModalOpen() {
    const modal = document.getElementById('modal-public-report');
    return !!(modal && !modal.classList.contains('hidden'));
}

function isSlaModalOpen() {
    const modal = document.getElementById('modal-sla-alert');
    return !!(modal && !modal.classList.contains('hidden'));
}

function stopSlaTones() {
    ['sla-warn-tone', 'sla-timeout-tone'].forEach((id) => {
        const audio = document.getElementById(id);
        if (!audio) return;
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch (e) { /* ignore */ }
    });
}

function startSlaTone(kind) {
    stopSlaTones();
    const id = kind === 'timeout' ? 'sla-timeout-tone' : 'sla-warn-tone';
    const audio = document.getElementById(id);
    if (!audio) return;
    try {
        audio.loop = true;
        audio.currentTime = 0;
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
            p.catch((err) => console.log(id + ' 播放失败', err && err.message ? err.message : err));
        }
    } catch (e) { /* ignore */ }
}

function resetSlaSteps() {
    const alertStep = document.getElementById('sla-step-alert');
    const detailStep = document.getElementById('sla-step-detail');
    if (alertStep) alertStep.classList.remove('hidden');
    if (detailStep) detailStep.classList.add('hidden');
}

function ackSlaStage(alert) {
    if (!alert) return;
    const id = String(alert.eventId);
    if (alert.stage === 'warn') {
        slaWarnAcked.add(id);
        saveSlaAckState();
        return;
    }
    // timeout
    slaWarnAcked.add(id);
    const repeat = Number(alert.repeatMinutes) || 0;
    if (repeat <= 0) {
        slaTimeoutDoneOnce.add(id);
        slaTimeoutLastAckAt.delete(id);
    } else {
        slaTimeoutLastAckAt.set(id, Date.now());
        slaTimeoutDoneOnce.delete(id);
    }
    saveSlaAckState();
}

function shouldShowTimeoutAlert(eventId, repeatMinutes) {
    const id = String(eventId);
    if (slaTimeoutDoneOnce.has(id)) return false;
    const last = slaTimeoutLastAckAt.get(id);
    if (last == null) return true; // 首次超时
    if (!repeatMinutes || repeatMinutes <= 0) return false;
    return (Date.now() - last) >= repeatMinutes * 60000;
}

function closeSlaModal() {
    stopSlaTones();
    if (pendingSlaAlert) ackSlaStage(pendingSlaAlert);
    const modal = document.getElementById('modal-sla-alert');
    if (modal) modal.classList.add('hidden');
    resetSlaSteps();
    pendingSlaAlert = null;
    setTimeout(() => evaluateSlaAlerts(), 50);
}

function showSlaDetail() {
    stopSlaTones();
    if (pendingSlaAlert) ackSlaStage(pendingSlaAlert);
    const alertStep = document.getElementById('sla-step-alert');
    const detailStep = document.getElementById('sla-step-detail');
    if (alertStep) alertStep.classList.add('hidden');
    if (detailStep) detailStep.classList.remove('hidden');
}

function openSlaEventDrawerFromModal() {
    const id = pendingSlaAlert && pendingSlaAlert.eventId;
    closeSlaModal();
    if (id) openEventDetail(id);
}

async function logSlaAlertToServer(alert) {
    if (!alert || !alert.eventId) return;
    try {
        const url = (window.Platform && window.Platform.api)
            ? window.Platform.api('/api/sla-alert-log')
            : '/api/sla-alert-log';
        await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                eventId: alert.eventId,
                stage: alert.stage,
                is_repeat: !!alert.isRepeat,
                report_type: alert.reportType || '',
                priority: alert.priority,
                elapsed_minutes: alert.elapsedMinutes,
                warn_minutes: alert.warnMinutes,
                timeout_minutes: alert.timeoutMinutes,
                repeat_minutes: alert.repeatMinutes
            })
        });
        if (openEventDetailId && Number(openEventDetailId) === Number(alert.eventId)) {
            refreshOpenEventDrawer();
        }
    } catch (e) {
        console.log('SLA 日志写入失败', e && e.message ? e.message : e);
    }
}

function showSlaModal(alert) {
    const modal = document.getElementById('modal-sla-alert');
    const card = document.getElementById('sla-alert-card');
    if (!modal || !alert) return;

    pendingSlaAlert = alert;
    logSlaAlertToServer(alert);

    const isTimeout = alert.stage === 'timeout';
    const isRepeat = !!(isTimeout && alert.isRepeat);
    const stageLabel = isTimeout ? (isRepeat ? '再次超时' : '超时') : '预告';
    const borderClass = isTimeout ? 'border-red-500' : 'border-amber-500';
    const badgeClass = isTimeout
        ? 'text-[10px] font-bold px-2 py-0.5 bg-red-900/80 text-red-200 animate-pulse'
        : 'text-[10px] font-bold px-2 py-0.5 bg-amber-900/80 text-amber-200 animate-pulse';
    const hintClass = isTimeout
        ? 'text-xs text-red-200 bg-red-950/60 border border-red-800 px-3 py-2 mt-3'
        : 'text-xs text-amber-200 bg-amber-950/50 border border-amber-800 px-3 py-2 mt-3';
    const ackBtnClass = isTimeout
        ? 'flex-1 py-2.5 bg-red-600 hover:bg-red-500 text-white font-semibold text-sm'
        : 'flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm';

    if (card) {
        card.className = 'max-w-md w-full p-6 border border-[#3d4f66] border-t-[3px] bg-[#1c2738] text-[#e8eef6] shadow-2xl ' + borderClass;
    }

    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    setText('sla-alert-heading', isTimeout ? (isRepeat ? '事件超时再次提醒' : '事件超时警报') : '事件 SLA 预告');
    setText('sla-detail-heading', isTimeout ? (isRepeat ? '再次超时详情' : '超时详情') : '预告详情');
    setText('sla-alert-title', alert.title || '--');
    setText('sla-detail-title', alert.title || '--');
    setText('sla-alert-report-type', alert.reportType || '其他问题求助');
    setText('sla-detail-report-type', alert.reportType || '其他问题求助');
    setText('sla-alert-priority', alert.priorityLabel || '');
    setText('sla-detail-priority', alert.priorityLabel || '');
    setText('sla-detail-contact', alert.contact || '未填写');
    setText('sla-detail-details', alert.details || '无');
    setText('sla-detail-elapsed', formatElapsedMinutes(alert.elapsedMinutes));
    const repeatText = alert.repeatMinutes > 0
        ? (' / 每 ' + alert.repeatMinutes + ' 分再提醒')
        : ' / 超时只提醒一次';
    setText(
        'sla-detail-thresholds',
        '预告 ' + alert.warnMinutes + ' 分 / 超时 ' + alert.timeoutMinutes + ' 分' + repeatText
    );

    const alertBadge = document.getElementById('sla-alert-badge');
    const detailBadge = document.getElementById('sla-detail-badge');
    if (alertBadge) {
        alertBadge.className = badgeClass;
        alertBadge.textContent = stageLabel;
    }
    if (detailBadge) {
        detailBadge.className = badgeClass.replace(' animate-pulse', '');
        detailBadge.textContent = stageLabel;
    }

    const hint = document.getElementById('sla-alert-hint');
    if (hint) {
        hint.className = hintClass;
        if (isTimeout) {
            hint.textContent = alert.repeatMinutes > 0
                ? ('超时警报音将循环播放；关闭后约每 ' + alert.repeatMinutes + ' 分钟再次提醒，直至有人到达现场。请点击「关闭」或「查看详情」停止本次提示音。')
                : '超时警报音将循环播放（仅本次）；请点击「关闭」或「查看详情」后停止。';
        } else {
            hint.textContent = '预告提示音将循环播放，请点击「关闭」或「查看详情」后停止。';
        }
    }
    const ackBtn = document.getElementById('btn-ack-sla-alert');
    if (ackBtn) ackBtn.className = ackBtnClass;

    resetSlaSteps();
    modal.classList.remove('hidden');
    startSlaTone(alert.stage);
}

function buildSlaCandidates() {
    if (!rmsSlaSettings) return [];
    const active = (allEvents || []).filter((ev) => ev.status === '未完成');
    const list = [];
    for (const ev of active) {
        if (eventHasArrivedOnScene(ev.id)) {
            slaStoppedByArrive.add(String(ev.id));
            continue;
        }
        const parsed = parseDescriptionFields(ev.description || '');
        const reportType = parsed.report_type || parseReportTypeFromDescription(ev.description || '') || '其他问题求助';
        const priority = Number(ev.priority) || 3;
        const thresholds = resolveEventSla(reportType, priority);
        if (!thresholds) continue;
        const elapsed = eventAgeMinutes(ev);
        const id = String(ev.id);

        let stage = null;
        let isRepeat = false;
        if (elapsed >= thresholds.timeoutMinutes) {
            if (shouldShowTimeoutAlert(ev.id, thresholds.repeatMinutes)) {
                stage = 'timeout';
                isRepeat = slaTimeoutLastAckAt.has(id);
            }
        } else if (elapsed >= thresholds.warnMinutes) {
            if (!slaWarnAcked.has(id)) stage = 'warn';
        }
        if (!stage) continue;

        list.push({
            eventId: ev.id,
            stage,
            isRepeat,
            title: ev.title || '未填写地点',
            reportType,
            priority,
            priorityLabel: SLA_PRIORITY_LABEL[priority] || '低优先级',
            contact: parsed.contact || '未填写',
            details: parsed.details || '',
            elapsedMinutes: elapsed,
            warnMinutes: thresholds.warnMinutes,
            timeoutMinutes: thresholds.timeoutMinutes,
            repeatMinutes: thresholds.repeatMinutes,
            rank: stage === 'timeout' ? 0 : 1
        });
    }
    list.sort((a, b) => a.rank - b.rank || b.elapsedMinutes - a.elapsedMinutes);
    return list;
}

function evaluateSlaAlerts() {
    if (!slaDashboardReady) return;
    // 清理已完成 / 已到达事件的状态
    const activeIds = new Set(
        (allEvents || []).filter((ev) => ev.status === '未完成').map((ev) => String(ev.id))
    );
    const cleanup = (store) => {
        if (store instanceof Set) {
            for (const key of Array.from(store)) {
                const id = String(key).split(':')[0];
                if (!activeIds.has(id)) store.delete(key);
            }
        } else if (store instanceof Map) {
            for (const key of Array.from(store.keys())) {
                if (!activeIds.has(String(key))) store.delete(key);
            }
        }
    };
    cleanup(slaWarnAcked);
    cleanup(slaTimeoutDoneOnce);
    cleanup(slaTimeoutLastAckAt);
    cleanup(slaStoppedByArrive);
    saveSlaAckState();

    stopSlaIfArrivedOnScene();

    if (isPublicReportModalOpen() || isSlaModalOpen()) return;

    const candidates = buildSlaCandidates();
    slaQueue = candidates;
    if (!candidates.length) return;
    showSlaModal(candidates[0]);
}

let targetUserId = null;

function openAssignModal(userId, username) {
    targetUserId = userId;
    const nameEl = document.getElementById('assign-target-name');
    if (nameEl) nameEl.innerText = username;

    const listEl = document.getElementById('admin-assign-event-list');
    if (listEl) {
        const activeEvents = allEvents.filter(ev => ev.status === '未完成');
        if (activeEvents.length === 0) {
            listEl.innerHTML = '<div class="text-gray-500 text-center py-2">当前没有可指派的进行中事件</div>';
        } else {
            listEl.innerHTML = activeEvents.map(ev => `
                <label class="flex items-center p-2 border rounded cursor-pointer hover:bg-gray-50">
                    <input type="radio" name="admin_selected_event" value="${ev.id}" class="mr-2">
                    <div>
                        <span class="font-bold text-sm">${escapeHtml(ev.title)}</span>
                        <span class="text-xs text-gray-500 ml-2">(${escapeHtml(ev.description || '无描述')})</span>
                    </div>
                </label>
            `).join('');
        }
    }

    const assignModal = document.getElementById('modal-admin-assign');
    if (assignModal) assignModal.classList.remove('hidden');
}

function batchAssignStatusLabel(status) {
    const map = {
        1: '待命',
        2: '不可用',
        3: '响应中',
        4: '到达现场',
        5: '紧急',
        6: '离线'
    };
    return map[Number(status)] || '未知';
}

function fillBatchAssignUserList(preselectEventId) {
    const listEl = document.getElementById('batch-assign-user-list');
    if (!listEl) return;
    const eventId = preselectEventId
        || Number((document.getElementById('batch-assign-event') || {}).value)
        || 0;
    const candidates = (allUsers || []).filter((u) => Number(u.status) !== 6);
    if (!candidates.length) {
        listEl.innerHTML = '<div class="text-center text-gray-400 py-6 text-sm">暂无可选人员</div>';
        return;
    }
    const sorted = [...candidates].sort((a, b) => {
        const sa = Number(a.status) === 1 ? 0 : 1;
        const sb = Number(b.status) === 1 ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return personDisplayName(a).localeCompare(personDisplayName(b), 'zh');
    });
    listEl.innerHTML = sorted.map((u) => {
        const already = eventId && Number(u.current_event_id) === Number(eventId);
        const name = personDisplayName(u);
        return `
            <label class="flex items-center gap-3 p-2.5 border rounded-lg cursor-pointer hover:bg-indigo-50 ${already ? 'bg-indigo-50/60 border-indigo-200' : ''}">
                <input type="checkbox" class="batch-assign-user accent-indigo-600" value="${u.id}"
                    data-status="${Number(u.status)}" ${already ? 'checked' : ''}>
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-bold text-gray-800">${escapeHtml(name)}</div>
                    <div class="text-[11px] text-gray-500 mt-0.5">
                        ${batchAssignStatusLabel(u.status)}
                        ${u.event_title ? ' · 当前：' + escapeHtml(u.event_title) : ''}
                        ${already ? ' · 已在本事件' : ''}
                    </div>
                </div>
            </label>
        `;
    }).join('');
}

function openBatchAssignModal(preselectEventId) {
    const modal = document.getElementById('modal-batch-assign');
    const selectEl = document.getElementById('batch-assign-event');
    if (!modal || !selectEl) return;

    const activeEvents = (allEvents || []).filter((ev) => ev.status === '未完成');
    if (!activeEvents.length) {
        alert('当前没有进行中的事件，请先新增或接收事件');
        return;
    }

    selectEl.innerHTML = activeEvents.map((ev) => {
        const type = parseReportTypeFromDescription(ev.description || '');
        const label = (type ? `【${type}】` : '') + (ev.title || ('#' + ev.id));
        return `<option value="${ev.id}">${escapeHtml(label)}</option>`;
    }).join('');

    const prefer = Number(preselectEventId) || 0;
    if (prefer && activeEvents.some((ev) => Number(ev.id) === prefer)) {
        selectEl.value = String(prefer);
    }

    fillBatchAssignUserList(Number(selectEl.value));
    modal.classList.remove('hidden');
}

function confirmBatchAssign() {
    const selectEl = document.getElementById('batch-assign-event');
    const eventId = parseInt(selectEl && selectEl.value, 10);
    if (!eventId) {
        alert('请选择目标事件');
        return;
    }
    const checked = Array.from(document.querySelectorAll('.batch-assign-user:checked'));
    const userIds = checked.map((el) => parseInt(el.value, 10)).filter((id) => id > 0);
    if (!userIds.length) {
        alert('请至少勾选一名队员');
        return;
    }

    const ev = (allEvents || []).find((e) => Number(e.id) === eventId);
    const title = (ev && ev.title) || ('#' + eventId);
    if (!confirm(`确认将 ${userIds.length} 名队员批量指派到「${title}」？`)) return;

    const btn = document.getElementById('btn-confirm-batch-assign');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '指派中…';
    }

    socket.emit('batch_assign_event', { eventId, userIds }, (resp) => {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '确认批量指派';
        }
        if (!resp || resp.success === false) {
            alert((resp && resp.message) || '批量指派失败');
            return;
        }
        const modal = document.getElementById('modal-batch-assign');
        if (modal) modal.classList.add('hidden');
        const assigned = resp.assigned != null ? resp.assigned : userIds.length;
        const skipped = resp.skipped != null ? resp.skipped : 0;
        alert(`批量指派完成：成功 ${assigned} 人` + (skipped ? `，跳过 ${skipped} 人（已在该事件）` : ''));
    });
}

let unicastTargetUserId = null;

function selectedChannel(name) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : '';
}

async function openBroadcastHistoryModal() {
    const modal = document.getElementById('modal-broadcast-history');
    const listEl = document.getElementById('broadcast-history-list');
    if (!modal || !listEl) return;
    listEl.innerHTML = '<div class="text-center text-gray-400 py-6">加载中…</div>';
    modal.classList.remove('hidden');
    try {
        const res = await fetch('/api/broadcast-history?limit=80', { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.success) {
            listEl.innerHTML = `<div class="text-center text-amber-600 py-6">${escapeHtml(data.message || '读取失败')}</div>`;
            return;
        }
        const rows = data.messages || [];
        if (!rows.length) {
            listEl.innerHTML = '<div class="text-center text-gray-400 py-6">暂无广播记录</div>';
            return;
        }
        listEl.innerHTML = rows.map((m) => {
            const time = m.created_at
                ? new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })
                : '';
            const ch = m.channel === 'all' ? '终端+企微' : (m.channel === 'wecom' ? '企微' : '终端');
            return `<div class="dc-inset-card p-3">
                <div class="flex justify-between gap-2 text-[11px] mb-1" style="color:var(--rms-muted)">
                    <span>发件人：${escapeHtml(m.actor_username || '—')} · ${escapeHtml(ch)} · ${Number(m.recipient_count) || 0} 人</span>
                    <span class="font-mono">${escapeHtml(time)}</span>
                </div>
                <div class="text-xs font-semibold mb-1 dc-soft-link">${escapeHtml(m.scope_label || '广播')}</div>
                <div class="text-sm whitespace-pre-wrap">${escapeHtml(m.message || '')}</div>
            </div>`;
        }).join('');
    } catch (err) {
        listEl.innerHTML = '<div class="text-center text-red-500 py-6">加载失败</div>';
    }
}

async function openUnicastHistoryModal(userId, displayName) {
    const modal = document.getElementById('modal-unicast-history');
    const nameEl = document.getElementById('unicast-history-name');
    const listEl = document.getElementById('unicast-history-list');
    if (!modal || !listEl) return;
    if (nameEl) nameEl.textContent = displayName || '未命名';
    listEl.innerHTML = '<div class="text-center text-gray-400 py-6">加载中…</div>';
    modal.classList.remove('hidden');
    try {
        const res = await fetch('/api/users/' + encodeURIComponent(userId) + '/unicast-history?limit=100', {
            credentials: 'same-origin'
        });
        const data = await res.json();
        if (!data.success) {
            listEl.innerHTML = `<div class="text-center text-amber-600 py-6">${escapeHtml(data.message || '读取失败')}</div>`;
            return;
        }
        const rows = data.messages || [];
        if (!rows.length) {
            listEl.innerHTML = '<div class="text-center text-gray-400 py-6">暂无单呼记录</div>';
            return;
        }
        listEl.innerHTML = rows.map((m) => {
            const time = m.created_at
                ? new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })
                : '';
            const ch = m.channel === 'all' ? '终端+企微' : (m.channel === 'wecom' ? '企微' : '终端');
            return `<div class="dc-inset-card p-3">
                <div class="flex justify-between gap-2 text-[11px] mb-1" style="color:var(--rms-muted)">
                    <span>发件人：${escapeHtml(m.actor_username || '—')} · ${escapeHtml(ch)}</span>
                    <span class="font-mono">${escapeHtml(time)}</span>
                </div>
                <div class="text-sm whitespace-pre-wrap">${escapeHtml(m.message || '')}</div>
            </div>`;
        }).join('');
    } catch (err) {
        listEl.innerHTML = '<div class="text-center text-red-500 py-6">加载失败</div>';
    }
}

function openUnicastModal(userId, displayName) {
    unicastTargetUserId = userId;
    const modal = document.getElementById('modal-unicast');
    const nameEl = document.getElementById('unicast-target-name');
    const idEl = document.getElementById('unicast-target-id');
    const msgEl = document.getElementById('unicast-message');
    if (!modal) return;
    if (nameEl) nameEl.textContent = displayName || '未命名';
    if (idEl) idEl.value = String(userId || '');
    if (msgEl) msgEl.value = '';
    const allRadio = document.querySelector('input[name="unicast_channel"][value="all"]');
    if (allRadio) allRadio.checked = true;
    modal.classList.remove('hidden');
}

function confirmUnicast() {
    const userId = unicastTargetUserId || parseInt((document.getElementById('unicast-target-id') || {}).value, 10);
    const message = (document.getElementById('unicast-message') || {}).value;
    const channel = selectedChannel('unicast_channel');
    const text = String(message || '').trim();
    if (!userId) {
        alert('未选择队员');
        return;
    }
    if (!text) {
        alert('请填写通知内容');
        return;
    }
    if (!channel) {
        alert('请选择发送渠道');
        return;
    }
    const btn = document.getElementById('btn-confirm-unicast');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '发送中…';
    }
    socket.emit('unicast_message', { userId, message: text, channel }, (resp) => {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '发送';
        }
        if (!resp || !resp.success) {
            alert((resp && resp.message) || '单呼发送失败');
            return;
        }
        const modal = document.getElementById('modal-unicast');
        if (modal) modal.classList.add('hidden');
        alert('单呼已发送');
    });
}

let broadcastScopeMode = 'all'; // all | groups | users
let broadcastSelectedAgencies = new Set();
let broadcastSelectedUserIds = new Set();

function isBroadcastIncludeUnavailable() {
    const el = document.getElementById('broadcast-include-unavailable');
    return !!(el && el.checked);
}

function collectBroadcastAgencyNames() {
    const fromSettings = (agencyListFromSettings || []).slice();
    const fromUsers = [];
    (allUsers || []).forEach((u) => {
        const ag = String(u.agency || '').trim();
        if (ag) fromUsers.push(ag);
    });
    const names = [];
    const seen = new Set();
    [...fromSettings, ...fromUsers].forEach((n) => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        names.push(n);
    });
    return names;
}

/** 与人员列表一致：排除离线(6)；可选排除不可用(2)。不排除当前登录账号。 */
function parseUserStatus(u) {
    const s = parseInt(u && u.status, 10);
    return Number.isFinite(s) ? s : null;
}

function filterBroadcastStatus(users, includeUnavailable) {
    return (users || []).filter((u) => {
        const s = parseUserStatus(u);
        if (s == null) return false;
        if (s === 6) return false;
        if (!includeUnavailable && s === 2) return false;
        return true;
    });
}

function getBroadcastTargetsPreview() {
    const includeUnavailable = isBroadcastIncludeUnavailable();
    const source = Array.isArray(allUsers) ? allUsers : [];
    if (broadcastScopeMode === 'users') {
        const idSet = broadcastSelectedUserIds;
        const picked = source.filter((u) => idSet.has(Number(u.id)));
        return filterBroadcastStatus(picked, includeUnavailable);
    }
    let base = filterBroadcastStatus(source, includeUnavailable);
    if (broadcastScopeMode === 'all') return base;
    if (!broadcastSelectedAgencies.size) return [];
    return base.filter((u) => {
        const ag = String(u.agency || '').trim();
        if (!ag) return broadcastSelectedAgencies.has('__none__');
        return broadcastSelectedAgencies.has(ag);
    });
}

function statusShortLabel(status) {
    const s = Number(status);
    return STATUS_TEXT[s] || ('状态' + s);
}

function renderBroadcastUserPickList() {
    const listEl = document.getElementById('broadcast-user-list');
    if (!listEl) return;
    const includeUnavailable = isBroadcastIncludeUnavailable();
    // 自选列表：展示非离线；不可用是否出现取决于勾选
    const candidates = filterBroadcastStatus(allUsers || [], includeUnavailable)
        .slice()
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b), 'zh'));
    if (!candidates.length) {
        listEl.innerHTML = '<div class="text-xs text-gray-400 py-3 text-center">没有可选人员</div>';
        return;
    }
    listEl.innerHTML = candidates.map((u) => {
        const id = Number(u.id);
        const checked = broadcastSelectedUserIds.has(id) ? 'checked' : '';
        const agency = String(u.agency || '').trim();
        return `
            <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border text-xs cursor-pointer hover:bg-teal-50">
                <input type="checkbox" class="broadcast-user-cb accent-teal-600" value="${id}" ${checked}>
                <span class="font-semibold text-gray-800 truncate">${escapeHtml(personDisplayName(u))}</span>
                <span class="text-gray-400 shrink-0">${escapeHtml(statusShortLabel(u.status))}</span>
                ${agency ? `<span class="ml-auto text-[10px] text-slate-500 shrink-0">${escapeHtml(agency)}</span>` : ''}
            </label>
        `;
    }).join('');
}

function syncBroadcastUserPickVisibility() {
    const wrap = document.getElementById('broadcast-user-pick-wrap');
    if (!wrap) return;
    if (broadcastScopeMode === 'users') {
        wrap.classList.remove('hidden');
        renderBroadcastUserPickList();
    } else {
        wrap.classList.add('hidden');
    }
}

function updateBroadcastPreview() {
    const targets = getBroadcastTargetsPreview();
    const countEl = document.getElementById('broadcast-preview-count');
    const namesEl = document.getElementById('broadcast-preview-names');
    if (countEl) countEl.textContent = String(targets.length);
    if (namesEl) {
        if (!targets.length) {
            const source = Array.isArray(allUsers) ? allUsers : [];
            const offline = source.filter((u) => parseUserStatus(u) === 6).length;
            const unavailable = source.filter((u) => parseUserStatus(u) === 2).length;
            if (broadcastScopeMode === 'users') {
                namesEl.textContent = '请在上方勾选人员';
            } else if (broadcastScopeMode === 'groups') {
                namesEl.textContent = '请点选分区芯片（可多选）';
            } else if (!source.length) {
                namesEl.textContent = '人员数据尚未加载，请稍候再开广播，或刷新页面';
            } else {
                namesEl.textContent = `当前没有符合条件的人（共 ${source.length} 人：离线 ${offline}，不可用 ${unavailable}）。若对方是「不可用」，请勾选下方选项。`;
            }
        } else {
            namesEl.textContent = targets.map((u) => personDisplayName(u)).join('、');
        }
    }
    const btn = document.getElementById('btn-confirm-broadcast');
    if (btn && btn.textContent !== '发送中…') btn.disabled = targets.length === 0;
}

function renderBroadcastScopeChips() {
    const box = document.getElementById('broadcast-scope-chips');
    if (!box) return;
    const agencyNames = collectBroadcastAgencyNames();
    const chipClass = (active) => active
        ? 'broadcast-scope-chip px-2.5 py-1.5 rounded-lg text-xs font-bold bg-teal-600 text-white shadow-sm'
        : 'broadcast-scope-chip px-2.5 py-1.5 rounded-lg text-xs font-bold bg-white border text-gray-700 hover:bg-teal-50';

    let html = `<button type="button" data-scope="__all__" class="${chipClass(broadcastScopeMode === 'all')}">全体</button>`;
    html += `<button type="button" data-scope="__users__" class="${chipClass(broadcastScopeMode === 'users')}">自选人员</button>`;
    agencyNames.forEach((name) => {
        const active = broadcastScopeMode === 'groups' && broadcastSelectedAgencies.has(name);
        html += `<button type="button" data-scope="${escapeHtml(name)}" class="${chipClass(active)}">${escapeHtml(name)}</button>`;
    });
    const noneActive = broadcastScopeMode === 'groups' && broadcastSelectedAgencies.has('__none__');
    html += `<button type="button" data-scope="__none__" class="${chipClass(noneActive)}">未分区</button>`;
    box.innerHTML = html;
}

function onBroadcastScopeChipClick(scope) {
    if (scope === '__all__') {
        broadcastScopeMode = 'all';
        broadcastSelectedAgencies.clear();
        broadcastSelectedUserIds.clear();
    } else if (scope === '__users__') {
        broadcastScopeMode = 'users';
        broadcastSelectedAgencies.clear();
    } else {
        broadcastScopeMode = 'groups';
        broadcastSelectedUserIds.clear();
        if (broadcastSelectedAgencies.has(scope)) {
            broadcastSelectedAgencies.delete(scope);
        } else {
            broadcastSelectedAgencies.add(scope);
        }
        if (!broadcastSelectedAgencies.size) {
            broadcastScopeMode = 'all';
        }
    }
    renderBroadcastScopeChips();
    syncBroadcastUserPickVisibility();
    updateBroadcastPreview();
}

function openBroadcastModal() {
    const modal = document.getElementById('modal-broadcast');
    if (!modal) return;
    // 若 socket 名单未写入，回退到仪表盘缓存
    if ((!allUsers || !allUsers.length) && latestDashboardUsers && latestDashboardUsers.length) {
        allUsers = latestDashboardUsers.slice();
    }
    broadcastScopeMode = 'all';
    broadcastSelectedAgencies = new Set();
    broadcastSelectedUserIds = new Set();
    const includeCb = document.getElementById('broadcast-include-unavailable');
    if (includeCb) includeCb.checked = false;
    renderBroadcastScopeChips();
    syncBroadcastUserPickVisibility();
    updateBroadcastPreview();
    const msgEl = document.getElementById('broadcast-message');
    if (msgEl) msgEl.value = '';
    const allRadio = document.querySelector('input[name="broadcast_channel"][value="all"]');
    if (allRadio) allRadio.checked = true;
    modal.classList.remove('hidden');
}

function confirmBroadcast() {
    const message = String((document.getElementById('broadcast-message') || {}).value || '').trim();
    const channel = selectedChannel('broadcast_channel');
    const includeUnavailable = isBroadcastIncludeUnavailable();
    const preview = getBroadcastTargetsPreview();

    let agencies = ['__all__'];
    let userIds = [];
    if (broadcastScopeMode === 'groups') {
        agencies = [...broadcastSelectedAgencies];
        if (!agencies.length) {
            alert('请选择全体、分区或自选人员');
            return;
        }
    } else if (broadcastScopeMode === 'users') {
        agencies = [];
        userIds = [...broadcastSelectedUserIds];
        if (!userIds.length) {
            alert('请至少勾选一名人员');
            return;
        }
    }

    if (!preview.length) {
        alert('所选范围内没有可通知人员（已排除离线' + (includeUnavailable ? '' : '与不可用') + '）');
        return;
    }
    if (!message) {
        alert('请填写广播内容');
        return;
    }
    if (!channel) {
        alert('请选择发送渠道');
        return;
    }

    const btn = document.getElementById('btn-confirm-broadcast');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '发送中…';
    }
    socket.emit('broadcast_message', {
        message,
        channel,
        agencies,
        userIds,
        includeUnavailable
    }, (resp) => {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '发送广播';
            updateBroadcastPreview();
        }
        if (!resp || !resp.success) {
            alert((resp && resp.message) || '广播发送失败');
            return;
        }
        const modal = document.getElementById('modal-broadcast');
        if (modal) modal.classList.add('hidden');
        const bits = [`已发送给 ${resp.count != null ? resp.count : 0} 人`];
        if (channel === 'terminal' || channel === 'all') {
            bits.push(`终端在线 ${resp.terminal_connected != null ? resp.terminal_connected : 0}`);
        }
        if ((channel === 'wecom' || channel === 'all') && resp.wecom_skipped) {
            bits.push('企微未配置或发送被跳过');
        }
        alert(bits.join(' · '));
    });
}

function bindAdminActions() {
    const personnelListEl = document.getElementById('personnel-list');
    if (personnelListEl && !personnelListEl.dataset.bound) {
        personnelListEl.dataset.bound = '1';
        personnelListEl.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl || !personnelListEl.contains(actionEl)) return;
            const action = actionEl.getAttribute('data-action');
            const userId = parseInt(actionEl.getAttribute('data-user-id'), 10);
            const name = actionEl.getAttribute('data-name') || '';
            if (action === 'open-certs' && userId) {
                openPersonnelCertsModal(userId);
                return;
            }
            if (action === 'unassign' && userId) {
                e.stopPropagation();
                unassignEvent(userId, name);
                return;
            }
            if (action === 'assign' && userId) {
                e.stopPropagation();
                openAssignModal(userId, name);
            }
        });
    }

    const btnOpen = document.getElementById('btn-admin-add-event');
    bindExportActivitySummary();
    const modal = document.getElementById('modal-admin-add-event');
    const btnClose = document.getElementById('btn-close-admin-add-modal');
    const form = document.getElementById('form-admin-add-event');

    if (btnOpen) btnOpen.addEventListener('click', () => modal.classList.remove('hidden'));
    if (btnClose) btnClose.addEventListener('click', () => modal.classList.add('hidden'));

    const btnBroadcast = document.getElementById('btn-broadcast');
    if (btnBroadcast) btnBroadcast.addEventListener('click', () => openBroadcastModal());
    const btnCloseBroadcast = document.getElementById('btn-close-broadcast');
    const broadcastModal = document.getElementById('modal-broadcast');
    if (btnCloseBroadcast && broadcastModal) {
        btnCloseBroadcast.addEventListener('click', () => broadcastModal.classList.add('hidden'));
        broadcastModal.addEventListener('click', (e) => {
            if (e.target === broadcastModal) broadcastModal.classList.add('hidden');
        });
    }
    const scopeChips = document.getElementById('broadcast-scope-chips');
    if (scopeChips) {
        scopeChips.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-scope]');
            if (!btn) return;
            onBroadcastScopeChipClick(btn.getAttribute('data-scope'));
        });
    }
    const includeUnavailableCb = document.getElementById('broadcast-include-unavailable');
    if (includeUnavailableCb) {
        includeUnavailableCb.addEventListener('change', () => {
            if (broadcastScopeMode === 'users') {
                // 取消勾选时清掉已选的不可用人员
                if (!includeUnavailableCb.checked) {
                    (allUsers || []).forEach((u) => {
                        if (Number(u.status) === 2) broadcastSelectedUserIds.delete(Number(u.id));
                    });
                }
                renderBroadcastUserPickList();
            }
            updateBroadcastPreview();
        });
    }
    const userListEl = document.getElementById('broadcast-user-list');
    if (userListEl) {
        userListEl.addEventListener('change', (e) => {
            const cb = e.target.closest('.broadcast-user-cb');
            if (!cb) return;
            const id = parseInt(cb.value, 10);
            if (!id) return;
            if (cb.checked) broadcastSelectedUserIds.add(id);
            else broadcastSelectedUserIds.delete(id);
            updateBroadcastPreview();
        });
    }
    const btnPickAll = document.getElementById('btn-broadcast-pick-all');
    if (btnPickAll) {
        btnPickAll.addEventListener('click', () => {
            document.querySelectorAll('.broadcast-user-cb').forEach((cb) => {
                cb.checked = true;
                const id = parseInt(cb.value, 10);
                if (id) broadcastSelectedUserIds.add(id);
            });
            updateBroadcastPreview();
        });
    }
    const btnPickNone = document.getElementById('btn-broadcast-pick-none');
    if (btnPickNone) {
        btnPickNone.addEventListener('click', () => {
            broadcastSelectedUserIds.clear();
            document.querySelectorAll('.broadcast-user-cb').forEach((cb) => { cb.checked = false; });
            updateBroadcastPreview();
        });
    }
    const btnConfirmBroadcast = document.getElementById('btn-confirm-broadcast');
    if (btnConfirmBroadcast) btnConfirmBroadcast.addEventListener('click', () => confirmBroadcast());
    const btnOpenBroadcastHist = document.getElementById('btn-open-broadcast-history');
    if (btnOpenBroadcastHist) {
        btnOpenBroadcastHist.addEventListener('click', () => openBroadcastHistoryModal());
    }
    const btnCloseBroadcastHist = document.getElementById('btn-close-broadcast-history');
    const broadcastHistModal = document.getElementById('modal-broadcast-history');
    if (btnCloseBroadcastHist && broadcastHistModal) {
        btnCloseBroadcastHist.addEventListener('click', () => broadcastHistModal.classList.add('hidden'));
        broadcastHistModal.addEventListener('click', (e) => {
            if (e.target === broadcastHistModal) broadcastHistModal.classList.add('hidden');
        });
    }

    const btnCloseUnicast = document.getElementById('btn-close-unicast');
    const unicastModal = document.getElementById('modal-unicast');
    if (btnCloseUnicast && unicastModal) {
        btnCloseUnicast.addEventListener('click', () => unicastModal.classList.add('hidden'));
        unicastModal.addEventListener('click', (e) => {
            if (e.target === unicastModal) unicastModal.classList.add('hidden');
        });
    }
    const btnConfirmUnicast = document.getElementById('btn-confirm-unicast');
    if (btnConfirmUnicast) btnConfirmUnicast.addEventListener('click', () => confirmUnicast());
    const btnOpenUnicast = document.getElementById('btn-open-unicast');
    if (btnOpenUnicast) {
        btnOpenUnicast.addEventListener('click', () => {
            const name = (document.getElementById('personnel-certs-name') || {}).textContent || '未命名';
            if (!unicastTargetUserId) {
                alert('请先打开队员详细信息');
                return;
            }
            openUnicastModal(unicastTargetUserId, name);
        });
    }
    const btnOpenUnicastHist = document.getElementById('btn-open-unicast-history');
    if (btnOpenUnicastHist) {
        btnOpenUnicastHist.addEventListener('click', () => {
            const name = (document.getElementById('personnel-certs-name') || {}).textContent || '未命名';
            if (!unicastTargetUserId) {
                alert('请先打开队员详细信息');
                return;
            }
            openUnicastHistoryModal(unicastTargetUserId, name);
        });
    }
    const btnCloseUnicastHist = document.getElementById('btn-close-unicast-history');
    const unicastHistModal = document.getElementById('modal-unicast-history');
    if (btnCloseUnicastHist && unicastHistModal) {
        btnCloseUnicastHist.addEventListener('click', () => unicastHistModal.classList.add('hidden'));
        unicastHistModal.addEventListener('click', (e) => {
            if (e.target === unicastHistModal) unicastHistModal.classList.add('hidden');
        });
    }

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const title = document.getElementById('admin-event-title').value.trim();
            const contact = document.getElementById('admin-event-contact').value.trim();
            const details = document.getElementById('admin-event-details').value.trim();
            const priority = parseInt(document.getElementById('admin-event-priority').value, 10);
            const typeEl = form.querySelector('input[name="admin_report_type"]:checked');
            const report_type = typeEl ? typeEl.value : '';
            if (!report_type) {
                alert('请选择求助类型');
                return;
            }
            if (!title || !contact || !details) {
                alert('请填写事件地点、联系方式和详细情况');
                return;
            }

            const publish = (force) => {
                socket.emit('add_event', { title, contact, details, priority, report_type, force: !!force }, (resp) => {
                    if (resp && resp.duplicate) {
                        const ok = confirm((resp.message || '检测到可能重复的事件') + '\n\n确定仍要发布吗？');
                        if (ok) publish(true);
                        return;
                    }
                    if (resp && resp.success === false) {
                        alert(resp.message || '发布失败');
                        return;
                    }
                    form.reset();
                    modal.classList.add('hidden');
                    alert('事件已发布');
                });
            };
            publish(false);
        });
    }

    const btnCloseAssign = document.getElementById('btn-close-admin-assign-modal');
    const assignModal = document.getElementById('modal-admin-assign');
    if (btnCloseAssign && assignModal) {
        btnCloseAssign.addEventListener('click', () => assignModal.classList.add('hidden'));
    }

    const btnConfirmAssign = document.getElementById('btn-confirm-assign');
    if (btnConfirmAssign) {
        btnConfirmAssign.addEventListener('click', () => {
            const selected = document.querySelector('input[name="admin_selected_event"]:checked');
            if (!selected) {
                alert('请先选择一个事件');
                return;
            }

            const eventId = parseInt(selected.value, 10);
            socket.emit('assign_event', { userId: targetUserId, eventId: eventId });

            if (assignModal) assignModal.classList.add('hidden');
        });
    }

    const btnBatchOpen = document.getElementById('btn-batch-assign');
    const batchModal = document.getElementById('modal-batch-assign');
    const btnCloseBatch = document.getElementById('btn-close-batch-assign');
    const btnConfirmBatch = document.getElementById('btn-confirm-batch-assign');
    const batchEventSelect = document.getElementById('batch-assign-event');
    const btnBatchStandby = document.getElementById('btn-batch-select-standby');
    const btnBatchNone = document.getElementById('btn-batch-select-none');

    if (btnBatchOpen) btnBatchOpen.addEventListener('click', () => openBatchAssignModal());
    if (btnCloseBatch && batchModal) {
        btnCloseBatch.addEventListener('click', () => batchModal.classList.add('hidden'));
    }
    if (btnConfirmBatch) btnConfirmBatch.addEventListener('click', () => confirmBatchAssign());
    if (batchEventSelect) {
        batchEventSelect.addEventListener('change', () => fillBatchAssignUserList(Number(batchEventSelect.value)));
    }
    if (btnBatchStandby) {
        btnBatchStandby.addEventListener('click', () => {
            document.querySelectorAll('.batch-assign-user').forEach((el) => {
                el.checked = Number(el.getAttribute('data-status')) === 1;
            });
        });
    }
    if (btnBatchNone) {
        btnBatchNone.addEventListener('click', () => {
            document.querySelectorAll('.batch-assign-user').forEach((el) => { el.checked = false; });
        });
    }

    const prModal = document.getElementById('modal-public-report');
    const btnClosePr = document.getElementById('btn-close-public-report');
    const btnViewPr = document.getElementById('btn-ack-public-report');
    const btnClosePrDetail = document.getElementById('btn-close-public-report-detail');
    const btnSavePrPriority = document.getElementById('btn-save-public-report-priority');

    if (btnClosePr) btnClosePr.addEventListener('click', () => closePublicReportModal());
    if (btnClosePrDetail) btnClosePrDetail.addEventListener('click', () => closePublicReportModal());
    if (btnViewPr) btnViewPr.addEventListener('click', () => showPublicReportDetail());
    if (btnSavePrPriority) btnSavePrPriority.addEventListener('click', () => savePublicReportPriority());
    // 点遮罩不关闭，避免误触导致提示音停掉前未处理
    if (prModal) {
        prModal.addEventListener('click', (e) => {
            if (e.target === prModal) {
                // 仅详情步骤允许点遮罩关闭；提示步骤必须点按钮
                const detailStep = document.getElementById('pr-step-detail');
                if (detailStep && !detailStep.classList.contains('hidden')) {
                    closePublicReportModal();
                }
            }
        });
    }

    const slaModal = document.getElementById('modal-sla-alert');
    const btnCloseSla = document.getElementById('btn-close-sla-alert');
    const btnAckSla = document.getElementById('btn-ack-sla-alert');
    const btnCloseSlaDetail = document.getElementById('btn-close-sla-detail');
    const btnOpenSlaDrawer = document.getElementById('btn-open-sla-event-drawer');
    if (btnCloseSla) btnCloseSla.addEventListener('click', () => closeSlaModal());
    if (btnCloseSlaDetail) btnCloseSlaDetail.addEventListener('click', () => closeSlaModal());
    if (btnAckSla) btnAckSla.addEventListener('click', () => showSlaDetail());
    if (btnOpenSlaDrawer) btnOpenSlaDrawer.addEventListener('click', () => openSlaEventDrawerFromModal());
    if (slaModal) {
        slaModal.addEventListener('click', (e) => {
            if (e.target === slaModal) {
                const detailStep = document.getElementById('sla-step-detail');
                if (detailStep && !detailStep.classList.contains('hidden')) {
                    closeSlaModal();
                }
            }
        });
    }

    const btnCloseDrawer = document.getElementById('btn-close-event-drawer');
    const drawerBackdrop = document.getElementById('drawer-event-backdrop');
    if (btnCloseDrawer) btnCloseDrawer.addEventListener('click', () => closeEventDrawer());
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => closeEventDrawer());

    const certModal = document.getElementById('modal-personnel-certs');
    const btnCloseCerts = document.getElementById('btn-close-personnel-certs');
    if (btnCloseCerts && certModal) {
        btnCloseCerts.addEventListener('click', () => certModal.classList.add('hidden'));
        certModal.addEventListener('click', (e) => {
            if (e.target === certModal) certModal.classList.add('hidden');
        });
    }
}

function formatCertDate(value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

async function openPersonnelCertsModal(userId) {
    const modal = document.getElementById('modal-personnel-certs');
    const nameEl = document.getElementById('personnel-certs-name');
    const listEl = document.getElementById('personnel-certs-list');
    if (!modal || !listEl) return;

    unicastTargetUserId = userId;
    nameEl.textContent = '加载中…';
    listEl.innerHTML = '<div class="text-center text-gray-400 py-6 text-sm">正在读取资质…</div>';
    modal.classList.remove('hidden');

    try {
        const res = await fetch('/api/personnel/' + encodeURIComponent(userId) + '/certs', {
            credentials: 'same-origin'
        });
        const data = await res.json();
        if (!data.success) {
            nameEl.textContent = '读取失败';
            listEl.innerHTML = `<div class="text-center text-amber-600 py-6 text-sm">${escapeHtml(data.message || '无法读取资质')}</div>`;
            return;
        }
        nameEl.textContent = data.display_name || '未命名';
        const certs = data.certs || [];
        if (!certs.length) {
            listEl.innerHTML = '<div class="text-center text-gray-400 py-6 text-sm">暂无勾选「调度可见」的资质</div>';
            return;
        }
        listEl.innerHTML = certs.map((c) => {
            const badge = c.type === 'internal'
                ? '<span class="dc-cert-badge is-internal">队内</span>'
                : '<span class="dc-cert-badge is-external">通用</span>';
            const dates = c.expiry_date
                ? `签发 ${escapeHtml(formatCertDate(c.issue_date))} · 有效至 ${escapeHtml(formatCertDate(c.expiry_date))}`
                : `签发 ${escapeHtml(formatCertDate(c.issue_date))}`;
            const img = c.image_url
                ? `<a href="/get_cert.php?file=${encodeURIComponent(c.image_url)}" target="_blank" rel="noopener" class="dc-soft-link text-xs font-semibold hover:underline">查看证书图</a>`
                : '<span class="text-xs" style="color:var(--rms-muted)">无附图</span>';
            return `
                <div class="dc-inset-card p-3 flex justify-between items-start gap-3">
                    <div class="min-w-0">
                        <div class="font-bold text-sm flex items-center gap-2 flex-wrap">
                            ${badge}
                            <span>${escapeHtml(c.cert_name || '')}</span>
                        </div>
                        <div class="text-[11px] mt-1" style="color:var(--rms-muted)">${dates}</div>
                    </div>
                    <div class="shrink-0">${img}</div>
                </div>
            `;
        }).join('');
    } catch (err) {
        nameEl.textContent = '读取失败';
        listEl.innerHTML = '<div class="text-center text-red-500 py-6 text-sm">网络错误，请稍后重试</div>';
    }
}

function todayInputDate() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
}

function priorityLabel(p) {
    const n = Number(p) || 3;
    if (n === 1) return "高";
    if (n === 2) return "中";
    return "低";
}

function formatEventTime(ev) {
    const raw = ev && (ev.created_at || ev.updated_at);
    if (!raw) return "—";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw).replace("T", " ").slice(0, 19);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
        + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function assigneesForEvent(eventId) {
    const id = Number(eventId);
    return (allUsers || []).filter((u) =>
        Number(u.current_event_id) === id || Number(u.pending_event_id) === id
    ).map((u) => {
        const name = (u.display_name || u.username || ("#" + u.id)).trim();
        const pendingOnly = Number(u.pending_event_id) === id && Number(u.current_event_id) !== id;
        return pendingOnly ? (name + "(待确认)") : name;
    });
}

function collectActivitySummaryRows() {
    const list = (allEvents || []).slice().sort((a, b) => {
        const sa = a.status === "已完成" ? 1 : 0;
        const sb = b.status === "已完成" ? 1 : 0;
        if (sa !== sb) return sa - sb;
        const pa = Number(a.priority) || 3;
        const pb = Number(b.priority) || 3;
        if (pa !== pb) return pa - pb;
        return Number(b.id) - Number(a.id);
    });
    return list.map((ev, idx) => {
        const fields = parseDescriptionFields(ev.description || "");
        const type = fields.report_type || "—";
        const names = assigneesForEvent(ev.id);
        return {
            index: idx + 1,
            title: ev.title || ("事件#" + ev.id),
            type,
            priority: priorityLabel(ev.priority),
            assignees: names.length ? names.join("、") : "—",
            status: ev.status === "已完成" ? "已完成" : "进行中",
            time: formatEventTime(ev),
            contact: fields.contact || "—"
        };
    });
}

function buildActivitySummaryHtml(activityName, activityDate) {
    const rows = collectActivitySummaryRows();
    const total = rows.length;
    const done = rows.filter((r) => r.status === "已完成").length;
    const active = total - done;
    const high = rows.filter((r) => r.priority === "高").length;
    const exportedAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const exporter = (currentUser && (currentUser.username || currentUser.display_name)) || "调度员";

    const bodyRows = rows.length
        ? rows.map((r) => (
            '<tr>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + r.index + '</td>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + escapeHtml(r.title) + '</td>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + escapeHtml(r.type) + '</td>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + escapeHtml(r.priority) + '</td>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + escapeHtml(r.assignees) + '</td>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + escapeHtml(r.status) + '</td>'
            + '<td style="padding:6px;border:1px solid #d0d7e2;">' + escapeHtml(r.time) + '</td>'
            + '</tr>'
        )).join('')
        : '<tr><td colspan="7" style="text-align:center;color:#666;padding:18px;border:1px solid #d0d7e2;">本场暂无事件记录</td></tr>';

    return (
        '<div id="activity-summary-pdf" style="font-family:Microsoft YaHei,PingFang SC,Noto Sans SC,sans-serif;color:#1a2332;padding:8px 4px;">'
        + '<div style="border-bottom:3px solid #0056b3;padding-bottom:10px;margin-bottom:14px;">'
        + '<div style="font-size:11px;color:#0056b3;font-weight:700;letter-spacing:0.12em;">RMS 调度复盘</div>'
        + '<h1 style="margin:6px 0 4px;font-size:20px;">本场事件汇总</h1>'
        + '<div style="font-size:13px;line-height:1.6;">'
        + '<div><b>活动名称：</b>' + escapeHtml(activityName) + '</div>'
        + '<div><b>活动日期：</b>' + escapeHtml(activityDate) + '</div>'
        + '<div><b>导出时间：</b>' + escapeHtml(exportedAt) + '　<b>导出人：</b>' + escapeHtml(exporter) + '</div>'
        + '</div></div>'
        + '<div style="display:flex;gap:10px;margin-bottom:14px;font-size:12px;">'
        + '<div style="flex:1;border:1px solid #b8c9db;padding:8px 10px;"><div style="color:#5a6b7d;">事件总数</div><div style="font-size:18px;font-weight:700;">' + total + '</div></div>'
        + '<div style="flex:1;border:1px solid #b8c9db;padding:8px 10px;"><div style="color:#5a6b7d;">进行中</div><div style="font-size:18px;font-weight:700;">' + active + '</div></div>'
        + '<div style="flex:1;border:1px solid #b8c9db;padding:8px 10px;"><div style="color:#5a6b7d;">已完成</div><div style="font-size:18px;font-weight:700;">' + done + '</div></div>'
        + '<div style="flex:1;border:1px solid #b8c9db;padding:8px 10px;"><div style="color:#5a6b7d;">高优先级</div><div style="font-size:18px;font-weight:700;">' + high + '</div></div>'
        + '</div>'
        + '<table style="width:100%;border-collapse:collapse;font-size:11px;">'
        + '<thead><tr style="background:#0056b3;color:#fff;">'
        + '<th style="padding:7px 6px;text-align:left;width:28px;">#</th>'
        + '<th style="padding:7px 6px;text-align:left;">地点</th>'
        + '<th style="padding:7px 6px;text-align:left;width:88px;">类型</th>'
        + '<th style="padding:7px 6px;text-align:left;width:40px;">优先级</th>'
        + '<th style="padding:7px 6px;text-align:left;">指派</th>'
        + '<th style="padding:7px 6px;text-align:left;width:52px;">完成情况</th>'
        + '<th style="padding:7px 6px;text-align:left;width:110px;">创建时间</th>'
        + '</tr></thead><tbody>'
        + bodyRows
        + '</tbody></table>'
        + '<div style="margin-top:14px;font-size:10px;color:#8090a0;line-height:1.5;">说明：指派含当前响应人员；标注「待确认」表示调度已指派、队员尚未接受。本表依据导出瞬间指挥台数据生成。</div>'
        + '</div>'
    );
}

function safePdfFileName(activityName, activityDate) {
    const name = String(activityName || "活动").replace(/[\\/:*?"<>|]+/g, "_").trim() || "活动";
    const date = String(activityDate || todayInputDate());
    return name + "_" + date + "_事件汇总.pdf";
}

async function generateActivitySummaryPdf(activityName, activityDate) {
    const html = buildActivitySummaryHtml(activityName, activityDate);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:920px;background:#fff;";
    host.innerHTML = html;
    document.body.appendChild(host);

    const filename = safePdfFileName(activityName, activityDate);
    try {
        if (typeof html2pdf === "undefined") {
            throw new Error("html2pdf 未加载");
        }
        const opt = {
            margin: [10, 10, 12, 10],
            filename,
            image: { type: "jpeg", quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
            jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
            pagebreak: { mode: ["css", "legacy"] }
        };
        await html2pdf().set(opt).from(host.firstElementChild).save();
    } catch (err) {
        console.error(err);
        const w = window.open("", "_blank");
        if (!w) {
            alert("无法生成 PDF，请允许弹窗后重试，或检查网络后刷新页面。");
            return;
        }
        w.document.open();
        w.document.write("<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>"
            + escapeHtml(activityName) + " 事件汇总</title>"
            + "<style>@page{size:A4 landscape;margin:12mm;} body{font-family:Microsoft YaHei,sans-serif;}"
            + "table{width:100%;border-collapse:collapse;} th,td{border:1px solid #cbd5e1;padding:6px;}"
            + "th{background:#0056b3;color:#fff;}</style></head><body>"
            + html + "<script>setTimeout(function(){window.print();},400);<\/script></body></html>");
        w.document.close();
    } finally {
        host.remove();
    }
}

function bindExportActivitySummary() {
    const modal = document.getElementById("modal-export-activity");
    const btnOpen = document.getElementById("btn-export-activity-summary");
    const btnClose = document.getElementById("btn-close-export-activity");
    const btnConfirm = document.getElementById("btn-confirm-export-activity");
    const nameEl = document.getElementById("export-activity-name");
    const dateEl = document.getElementById("export-activity-date");
    const hintEl = document.getElementById("export-activity-hint");
    if (!modal || !btnOpen) return;

    const close = () => {
        modal.classList.add("hidden");
        if (hintEl) {
            hintEl.classList.add("hidden");
            hintEl.textContent = "";
        }
    };

    btnOpen.addEventListener("click", () => {
        if (dateEl && !dateEl.value) dateEl.value = todayInputDate();
        if (nameEl) nameEl.focus();
        modal.classList.remove("hidden");
    });
    if (btnClose) btnClose.addEventListener("click", close);
    modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
    });
    if (btnConfirm) {
        btnConfirm.addEventListener("click", async () => {
            const name = (nameEl && nameEl.value || "").trim();
            const date = (dateEl && dateEl.value || "").trim();
            if (!name || !date) {
                if (hintEl) {
                    hintEl.textContent = "请填写活动名称和活动日期";
                    hintEl.classList.remove("hidden");
                }
                return;
            }
            btnConfirm.disabled = true;
            btnConfirm.textContent = "生成中…";
            try {
                await generateActivitySummaryPdf(name, date);
                close();
            } finally {
                btnConfirm.disabled = false;
                btnConfirm.textContent = "生成 PDF";
            }
        });
    }
}
