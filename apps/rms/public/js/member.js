let currentUser = null;
let allEvents = [];
let socket = null;
let isEmergencyActive = false; // 记录当前是否处于紧急状态
let isEmergencyHolding = false;
let myCurrentEventId = null;
let myPendingEventId = null;
let latestDispatchMessage = null;
let offlineFlushTimer = null;

function queueUserId() {
    return currentUser && currentUser.id != null ? currentUser.id : 0;
}

function linkIsOnline() {
    return !!(window.RmsOfflineQueue && RmsOfflineQueue.isOnline(socket));
}

function updateLinkBanner() {
    const banner = document.getElementById('tm-link-banner');
    const textEl = document.getElementById('tm-link-banner-text');
    if (!banner || !textEl) return;
    const n = window.RmsOfflineQueue ? RmsOfflineQueue.count(queueUserId()) : 0;
    const online = linkIsOnline();
    if (online && n <= 0) {
        banner.classList.add('hidden');
        return;
    }
    banner.classList.remove('hidden');
    if (!online && n > 0) {
        textEl.textContent = '网络不稳，已有 ' + n + ' 项操作在本地排队，恢复后自动回传。';
    } else if (!online) {
        textEl.textContent = '当前弱网/离线，操作将先保存在本机，联网后自动回传。';
    } else {
        textEl.textContent = '网络已恢复，仍有 ' + n + ' 项待回传，正在发送…';
    }
}

function scheduleOfflineFlush() {
    if (offlineFlushTimer) clearTimeout(offlineFlushTimer);
    offlineFlushTimer = setTimeout(function () {
        flushOfflineQueue();
    }, 400);
}

function flushOfflineQueue() {
    if (!window.RmsOfflineQueue || !currentUser || !socket) return;
    updateLinkBanner();
    RmsOfflineQueue.flush(queueUserId(), socket, function () {
        updateLinkBanner();
    }).then(function () {
        updateLinkBanner();
    });
}

function applyOptimisticStatus(statusNum, eventId, eventTitle) {
    const statusBadge = document.getElementById('my-status-badge');
    const n = parseInt(statusNum, 10);
    isEmergencyActive = (n === 5);

    if (n === 1 || n === 2 || n === 6) {
        myCurrentEventId = null;
    } else if (eventId != null && (n === 3 || n === 4)) {
        myCurrentEventId = eventId;
    }

    const statusMap = {
        1: { text: '待命', class: 'tm-lcd-status is-standby' },
        2: { text: '不可用', class: 'tm-lcd-status is-off' },
        3: { text: '响应中', class: 'tm-lcd-status is-busy' },
        4: { text: '到达现场', class: 'tm-lcd-status is-scene' },
        5: { text: '紧急报警', class: 'tm-lcd-status is-emergency' },
        6: { text: '离线', class: 'tm-lcd-status is-offline' }
    };
    const currentSt = statusMap[n] || statusMap[6];
    if (statusBadge) {
        statusBadge.innerText = currentSt.text + (linkIsOnline() ? '' : '·待回传');
        statusBadge.className = currentSt.class;
    }

    if (n === 1 || n === 2 || n === 6) {
        syncCurrentEventCard(null);
    } else if (n === 3 || n === 4) {
        syncCurrentEventCard(eventId != null ? eventId : myCurrentEventId, eventTitle);
    } else {
        syncCurrentEventCard(myCurrentEventId, eventTitle);
    }
    updateEmergencyButtonUI();
    updateStatusButtonsLock();
}

/** 同步「当前响应事件」区与停止响应按钮（无事件时灰显禁用） */
function syncCurrentEventCard(eventId, eventTitle) {
    const card = document.getElementById('current-event-card');
    const titleEl = document.getElementById('current-event-title');
    const stopBtn = document.getElementById('btn-stop-responding');
    if (!card || !titleEl || !stopBtn) return;

    const hasEvent = eventId != null && Number(eventId) > 0;
    myCurrentEventId = hasEvent ? Number(eventId) : null;
    card.classList.remove('hidden');

    if (hasEvent) {
        if (eventTitle) titleEl.innerText = eventTitle;
        else if (!titleEl.innerText || titleEl.innerText === '暂无' || titleEl.innerText === '--') {
            titleEl.innerText = '事件 #' + eventId;
        }
        stopBtn.disabled = false;
        stopBtn.classList.remove('is-disabled');
        card.classList.remove('is-empty');
    } else {
        titleEl.innerText = '暂无';
        stopBtn.disabled = true;
        stopBtn.classList.add('is-disabled');
        card.classList.add('is-empty');
    }
}

/**
 * 在线直发；离线写入 localStorage 队列（不改库表）
 */
function emitReliable(eventName, data, options) {
    const opts = options || {};
    const online = linkIsOnline();
    if (!online) {
        if (!window.RmsOfflineQueue || !currentUser) {
            showTmNotice('当前离线且无法写入本地队列，请恢复网络后重试。');
            return Promise.resolve({ queued: false, failed: true });
        }
        RmsOfflineQueue.enqueue(queueUserId(), {
            event: eventName,
            data: data,
            priority: opts.priority || 'normal',
            coalesceKey: opts.coalesceKey || null,
            label: opts.label || eventName
        });
        updateLinkBanner();
        if (typeof opts.onQueued === 'function') opts.onQueued();
        return Promise.resolve({ queued: true });
    }

    if (opts.withAck) {
        return new Promise(function (resolve) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                // 发出超时：改入本地队列，避免丢失
                if (window.RmsOfflineQueue && currentUser) {
                    RmsOfflineQueue.enqueue(queueUserId(), {
                        event: eventName,
                        data: data,
                        priority: opts.priority || 'normal',
                        coalesceKey: opts.coalesceKey || null,
                        label: opts.label || eventName
                    });
                    updateLinkBanner();
                    if (typeof opts.onQueued === 'function') opts.onQueued();
                }
                resolve({ queued: true, timeout: true });
            }, 8000);
            socket.emit(eventName, data, function (resp) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ queued: false, resp: resp });
            });
        });
    }

    socket.emit(eventName, data);
    return Promise.resolve({ queued: false });
}

function bindOfflineQueueUi() {
    const btnFlush = document.getElementById('btn-flush-offline-queue');
    if (btnFlush) {
        btnFlush.addEventListener('click', function () {
            flushOfflineQueue();
        });
    }
    window.addEventListener('online', function () {
        updateLinkBanner();
        scheduleOfflineFlush();
    });
    window.addEventListener('offline', function () {
        updateLinkBanner();
    });
    if (socket) {
        socket.on('connect', function () {
            updateLinkBanner();
            scheduleOfflineFlush();
        });
        socket.on('disconnect', function () {
            updateLinkBanner();
        });
    }
    updateLinkBanner();
    scheduleOfflineFlush();
}

function showTmNotice(message, title) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-tm-notice');
        const titleEl = document.getElementById('tm-notice-title');
        const msgEl = document.getElementById('tm-notice-message');
        const okBtn = document.getElementById('tm-notice-ok');
        if (!modal || !okBtn) {
            resolve();
            return;
        }
        if (titleEl) titleEl.textContent = title || '提示';
        if (msgEl) msgEl.textContent = message || '';
        const close = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', close);
            resolve();
        };
        okBtn.addEventListener('click', close);
        modal.classList.remove('hidden');
    });
}

function showTmConfirm(message, options) {
    const opts = options || {};
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-tm-confirm');
        const titleEl = document.getElementById('tm-confirm-title');
        const msgEl = document.getElementById('tm-confirm-message');
        const okBtn = document.getElementById('tm-confirm-ok');
        const cancelBtn = document.getElementById('tm-confirm-cancel');
        if (!modal || !okBtn || !cancelBtn) {
            resolve(false);
            return;
        }
        if (titleEl) titleEl.textContent = opts.title || '请确认';
        if (msgEl) msgEl.textContent = message || '';
        okBtn.textContent = opts.okText || '确定';
        cancelBtn.textContent = opts.cancelText || '取消';
        okBtn.className = opts.danger
            ? 'tm-btn tm-btn-danger'
            : 'tm-btn tm-btn-primary';

        const finish = (ok) => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            resolve(ok);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onBackdrop = (e) => {
            if (e.target === modal) finish(false);
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        modal.classList.remove('hidden');
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (!data.success) {
        window.location.href = '/login.php?redirect=' + encodeURIComponent('/rms/');
        return;
    }
    currentUser = data.user;

    initHeader(currentUser);
    socket = io(window.Platform ? window.Platform.ioOptions() : { path: '/rms/socket.io' });
    
    // 收到警报时，写入公告栏而不弹窗
    initEmergencyListener(socket, (data) => {
        const board = document.getElementById('announcement-board');
        const list = document.getElementById('announcement-list');
        
        board.classList.remove('hidden');
        
        const timeStr = new Date().toLocaleTimeString('zh-CN');
        const newAlert = document.createElement('div');
        newAlert.innerHTML = `<strong>[${timeStr}]</strong> 队员 <strong>【${escapeHtml(data.username)}】</strong> 激活了紧急报警！`;
        
        list.prepend(newAlert);
    });

    socket.on('data_updated', (payload) => {
        const myData = payload.users.find(u => u.id === currentUser.id);
        allEvents = payload.events || [];
        if (myData) renderMyStatus(myData);
    });

    socket.on('dispatch_message', (payload) => {
        showDispatchMessageBanner(payload);
    });

    socket.on('assign_offer', (payload) => {
        if (payload && payload.eventId) {
            myPendingEventId = Number(payload.eventId);
            renderPendingAssign({
                pending_event_id: payload.eventId,
                pending_event_title: payload.title,
                pending_contact: payload.contact,
                pending_details: payload.details
            });
        }
    });

    bindStatusButtons();
    bindEventModalControls();
    bindEmergencyLongPress();
    bindAddEventForm();
    bindDispatchMessageUi();
    bindAssignActions();
    bindOfflineQueueUi();
    loadLatestMessageFromHistory();
});

function playMessageToneOnce() {
    if (typeof unlockAlarmAudioOnce === 'function') {
        try { unlockAlarmAudioOnce(); } catch (_) { /* ignore */ }
    }
    if (typeof playEventToneOnce === 'function') {
        playEventToneOnce();
        return;
    }
    const tone = document.getElementById('message-tone');
    if (!tone) return;
    try {
        tone.loop = false;
        tone.pause();
        tone.currentTime = 0;
    } catch (_) { /* ignore */ }
    const p = tone.play();
    if (p && typeof p.catch === 'function') {
        p.catch((err) => console.log('message-tone 播放失败', err && err.message ? err.message : err));
    }
}

function kindTitle(kind) {
    if (kind === 'broadcast') return '调度广播';
    if (kind === 'emergency') return '紧急报警';
    return '调度单呼';
}

function showDispatchMessageBanner(payload, opts = {}) {
    if (!payload) return;
    latestDispatchMessage = payload;
    if (!opts.silent) playMessageToneOnce();

    const banner = document.getElementById('dispatch-message-banner');
    const titleEl = document.getElementById('dispatch-message-banner-title');
    const previewEl = document.getElementById('dispatch-message-banner-preview');
    const metaEl = document.getElementById('dispatch-message-banner-meta');
    if (!banner) return;

    if (titleEl) titleEl.textContent = kindTitle(payload.kind);
    if (previewEl) previewEl.textContent = payload.preview || payload.message || '';
    if (metaEl) {
        const timeStr = payload.created_at
            ? new Date(payload.created_at).toLocaleString('zh-CN', { hour12: false })
            : new Date().toLocaleTimeString('zh-CN');
        metaEl.textContent = `来自 ${payload.from || '调度员'} · ${timeStr} · 点击查看全文`;
    }
    banner.classList.remove('hidden');
}

function dismissDispatchBanner() {
    const banner = document.getElementById('dispatch-message-banner');
    if (banner) banner.classList.add('hidden');
}

function openDispatchMessageModal(payload) {
    const p = payload || latestDispatchMessage;
    if (!p) return;
    latestDispatchMessage = p;
    const modal = document.getElementById('modal-dispatch-message');
    if (!modal) return;
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text == null ? '' : String(text);
    };
    setText('dm-title', kindTitle(p.kind));
    setText('dm-kind', p.kind === 'broadcast' ? '广播' : (p.kind === 'emergency' ? '紧急' : '单呼'));
    setText('dm-from', '发件人：' + (p.from || '调度员'));
    setText('dm-time', p.created_at
        ? new Date(p.created_at).toLocaleString('zh-CN', { hour12: false })
        : '');
    setText('dm-body', p.message || '');
    modal.classList.remove('hidden');
}

async function loadLatestMessageFromHistory() {
    try {
        const res = await fetch('/api/me/messages?limit=1', { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.success || !data.messages || !data.messages.length) return;
        const m = data.messages[0];
        showDispatchMessageBanner({
            id: m.id,
            kind: m.kind,
            message: m.message,
            preview: String(m.message || '').slice(0, 80),
            from: m.actor_username || '调度员',
            created_at: m.created_at
        }, { silent: true });
    } catch (_) { /* ignore */ }
}

async function openMessageHistory() {
    const modal = document.getElementById('modal-message-history');
    const list = document.getElementById('message-history-list');
    if (!modal || !list) return;
    showMessageHistoryList();
    list.innerHTML = '<div class="text-center text-gray-400 py-6">加载中…</div>';
    modal.classList.remove('hidden');
    try {
        const res = await fetch('/api/me/messages?limit=100', { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.success) {
            list.innerHTML = `<div class="text-center text-red-500 py-6">${escapeHtml(data.message || '加载失败')}</div>`;
            return;
        }
        const rows = data.messages || [];
        if (!rows.length) {
            list.innerHTML = '<div class="text-center text-gray-400 py-6">暂无信息记录</div>';
            return;
        }
        list.innerHTML = rows.map((m) => {
            const time = m.created_at
                ? new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })
                : '';
            const kind = kindTitle(m.kind);
            const body = escapeHtml(m.message || '');
            const from = escapeHtml(m.actor_username || '—');
            const scope = m.scope_label ? ' · ' + escapeHtml(m.scope_label) : '';
            return `<button type="button" class="msg-hist-item w-full text-left p-3 rounded-xl border border-gray-100 hover:bg-gray-50" data-id="${m.id}">
                <div class="flex justify-between gap-2 text-[11px] text-gray-400 mb-1">
                    <span class="font-bold text-teal-700">${escapeHtml(kind)}</span>
                    <span class="font-mono">${escapeHtml(time)}</span>
                </div>
                <div class="text-xs text-gray-500 mb-1">来自 ${from}${scope}</div>
                <div class="text-sm text-gray-800 line-clamp-2 whitespace-pre-wrap">${body}</div>
            </button>`;
        }).join('');
        list.querySelectorAll('.msg-hist-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = Number(btn.getAttribute('data-id'));
                const m = rows.find((x) => Number(x.id) === id);
                if (!m) return;
                showMessageHistoryDetail(m);
            });
        });
    } catch (err) {
        list.innerHTML = '<div class="text-center text-red-500 py-6">加载失败</div>';
    }
}

function showMessageHistoryList() {
    const listWrap = document.getElementById('message-history-list-wrap');
    const detail = document.getElementById('message-history-detail');
    const back = document.getElementById('btn-message-history-back');
    const heading = document.getElementById('message-history-heading');
    if (listWrap) listWrap.classList.remove('hidden');
    if (detail) detail.classList.add('hidden');
    if (back) back.classList.add('hidden');
    if (heading) heading.textContent = '信息历史';
}

function showMessageHistoryDetail(m) {
    const listWrap = document.getElementById('message-history-list-wrap');
    const detail = document.getElementById('message-history-detail');
    const back = document.getElementById('btn-message-history-back');
    const heading = document.getElementById('message-history-heading');
    if (listWrap) listWrap.classList.add('hidden');
    if (detail) detail.classList.remove('hidden');
    if (back) back.classList.remove('hidden');
    if (heading) heading.textContent = '详细信息';
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text == null ? '' : String(text);
    };
    setText('mhd-kind', m.kind === 'broadcast' ? '广播' : (m.kind === 'emergency' ? '紧急' : '单呼'));
    setText('mhd-from', '发件人：' + (m.actor_username || m.from || '调度员')
        + (m.scope_label ? ' · ' + m.scope_label : ''));
    setText('mhd-time', m.created_at
        ? new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })
        : '');
    setText('mhd-body', m.message || '');
}

function bindDispatchMessageUi() {
    const body = document.getElementById('dispatch-message-banner-body');
    if (body) {
        body.addEventListener('click', () => {
            playMessageToneOnce();
            openDispatchMessageModal();
        });
        body.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                playMessageToneOnce();
                openDispatchMessageModal();
            }
        });
    }
    const btnDismiss = document.getElementById('btn-dismiss-dispatch-banner');
    if (btnDismiss) btnDismiss.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissDispatchBanner();
    });
    const btnHist = document.getElementById('btn-open-message-history');
    if (btnHist) btnHist.addEventListener('click', openMessageHistory);
    const btnCloseHist = document.getElementById('btn-close-message-history');
    const modalHist = document.getElementById('modal-message-history');
    const btnBack = document.getElementById('btn-message-history-back');
    if (btnBack) btnBack.addEventListener('click', () => showMessageHistoryList());
    if (btnCloseHist && modalHist) {
        btnCloseHist.addEventListener('click', () => {
            showMessageHistoryList();
            modalHist.classList.add('hidden');
        });
        modalHist.addEventListener('click', (e) => {
            if (e.target === modalHist) {
                showMessageHistoryList();
                modalHist.classList.add('hidden');
            }
        });
    }
    const modal = document.getElementById('modal-dispatch-message');
    const btnClose = document.getElementById('btn-close-dispatch-message');
    if (btnClose && modal) {
        btnClose.addEventListener('click', () => modal.classList.add('hidden'));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    }
}

function renderPendingAssign(myData) {
    const card = document.getElementById('pending-assign-card');
    const titleEl = document.getElementById('pending-assign-title');
    const metaEl = document.getElementById('pending-assign-meta');
    if (!card) return;
    const pendingId = myData && myData.pending_event_id != null ? Number(myData.pending_event_id) : null;
    myPendingEventId = pendingId;
    if (!pendingId) {
        card.classList.add('hidden');
        return;
    }
    const title = myData.pending_event_title || ('事件 #' + pendingId);
    if (titleEl) titleEl.textContent = title;
    if (metaEl) {
        const lines = [];
        if (myData.pending_contact) lines.push('联系方式：' + myData.pending_contact);
        if (myData.pending_details) lines.push('详细情况：' + myData.pending_details);
        metaEl.textContent = lines.join('\n') || '请确认是否接受该调度指派。接受后将进入「响应中」。';
    }
    card.classList.remove('hidden');
}

function bindAssignActions() {
    const btnAccept = document.getElementById('btn-accept-assign');
    const btnReject = document.getElementById('btn-reject-assign');
    if (btnAccept) {
        btnAccept.addEventListener('click', async () => {
            if (!currentUser) return;
            const result = await emitReliable('accept_assign', { userId: currentUser.id }, {
                withAck: true,
                label: '接受指派',
                onQueued: function () {
                    showTmNotice('网络不稳，接受指派已加入本地队列，恢复后自动回传。', '已入队');
                }
            });
            if (result && result.resp && !result.resp.success) {
                showTmNotice(result.resp.message || '接受失败');
            }
        });
    }
    if (btnReject) {
        btnReject.addEventListener('click', async () => {
            if (!currentUser) return;
            const ok = await showTmConfirm('确定拒绝该调度指派吗？', {
                title: '拒绝指派',
                okText: '拒绝',
                danger: true
            });
            if (!ok) return;
            const result = await emitReliable('reject_assign', { userId: currentUser.id }, {
                withAck: true,
                label: '拒绝指派',
                onQueued: function () {
                    showTmNotice('网络不稳，拒绝指派已加入本地队列，恢复后自动回传。', '已入队');
                }
            });
            if (result && result.resp && !result.resp.success) {
                showTmNotice(result.resp.message || '拒绝失败');
            }
        });
    }
}

const TOP_STATUS_BTN_IDS = ['btn-status-1', 'btn-status-2', 'btn-status-3', 'btn-status-4'];

function setBtnEnabled(btn, enabled) {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.classList.toggle('is-disabled', !enabled);
}

/** 紧急：锁全部上方四键；响应中/到达现场：仅允许响应中、到达现场、紧急，待命/不可用/离线禁用 */
function updateStatusButtonsLock() {
    const inMission = !!myCurrentEventId;

    TOP_STATUS_BTN_IDS.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        if (isEmergencyActive) {
            setBtnEnabled(btn, false);
            return;
        }
        if (inMission) {
            setBtnEnabled(btn, id === 'btn-status-3' || id === 'btn-status-4');
            return;
        }
        setBtnEnabled(btn, true);
    });

    const offlineBtn = document.getElementById('btn-status-6');
    if (offlineBtn) {
        setBtnEnabled(offlineBtn, !isEmergencyActive && !inMission);
    }
}

function bindStatusButtons() {
    document.getElementById('btn-status-1').addEventListener('click', () => {
        if (isEmergencyActive) return;
        if (document.getElementById('btn-status-1').disabled) return;
        changeStatus(1);
    });

    document.getElementById('btn-status-2').addEventListener('click', () => {
        if (isEmergencyActive) return;
        if (document.getElementById('btn-status-2').disabled) return;
        changeStatus(2);
    });
    document.getElementById('btn-status-4').addEventListener('click', () => {
        if (isEmergencyActive) return;
        if (!myCurrentEventId) {
            showTmNotice('请先进入「响应中」并绑定事件，再标记到达现场。');
            return;
        }
        changeStatus(4, myCurrentEventId);
    });
    document.getElementById('btn-status-3').addEventListener('click', () => {
        if (isEmergencyActive) return;
        // 已绑定事件：只切回「响应中」，不再弹出选事件
        if (myCurrentEventId) {
            changeStatus(3, myCurrentEventId);
            return;
        }
        openSelectEventModal();
    });
    document.getElementById('btn-status-6').addEventListener('click', () => {
        if (document.getElementById('btn-status-6').disabled) return;
        changeStatus(6);
    });

    document.getElementById('btn-stop-responding').addEventListener('click', async () => {
        if (!myCurrentEventId) return;
        const stopBtn = document.getElementById('btn-stop-responding');
        if (stopBtn && stopBtn.disabled) return;
        const ok = await showTmConfirm('确定停止响应当前事件？停止后将失去事件指派。', {
            title: '停止响应',
            okText: '停止响应',
            danger: true
        });
        if (!ok) return;
        // 无论在线/离线都先清掉「当前响应事件」，避免必须刷新
        applyOptimisticStatus(1, null);
        emitReliable('stop_responding', { userId: currentUser.id }, {
            label: '停止响应',
            onQueued: function () {
                showTmNotice('网络不稳，停止响应已加入本地队列。', '已入队');
            }
        });
    });
}

function changeStatus(statusNum, eventId = null) {
    if (isEmergencyActive && statusNum !== 5) return;
    emitReliable('change_status', { userId: currentUser.id, status: statusNum, eventId: eventId }, {
        coalesceKey: 'change_status',
        label: '切换状态',
        onQueued: function () {
            applyOptimisticStatus(statusNum, eventId);
        }
    });
    if (!linkIsOnline()) applyOptimisticStatus(statusNum, eventId);
}

/** @deprecated 使用 updateStatusButtonsLock */
function updateTopStatusButtonsLock() {
    updateStatusButtonsLock();
}

function renderMyStatus(myData) {
    const statusBadge = document.getElementById('my-status-badge');

    const statusNum = parseInt(myData.status, 10);
    isEmergencyActive = (statusNum === 5);

    if (myData.current_event_id && myData.event_title) {
        syncCurrentEventCard(myData.current_event_id, myData.event_title);
    } else if (myData.current_event_id) {
        syncCurrentEventCard(myData.current_event_id, '事件 #' + myData.current_event_id);
    } else {
        syncCurrentEventCard(null);
    }

    updateEmergencyButtonUI();
    updateStatusButtonsLock();
    renderPendingAssign(myData);

    const statusMap = {
        1: { text: '待命', class: 'tm-lcd-status is-standby' },
        2: { text: '不可用', class: 'tm-lcd-status is-off' },
        3: { text: '响应中', class: 'tm-lcd-status is-busy' },
        4: { text: '到达现场', class: 'tm-lcd-status is-scene' },
        5: { text: '紧急报警', class: 'tm-lcd-status is-emergency' },
        6: { text: '离线', class: 'tm-lcd-status is-offline' }
    };

    const currentSt = statusMap[statusNum] || statusMap[6];
    statusBadge.innerText = currentSt.text;
    statusBadge.className = currentSt.class;
}

function updateEmergencyButtonUI() {
    const btn = document.getElementById('btn-status-5');
    if (!btn || isEmergencyHolding) return;

    if (isEmergencyActive) {
        btn.className = 'tm-key tm-key-emergency is-active';
        btn.textContent = '取消紧急';
        btn.setAttribute('aria-label', '取消紧急');
    } else {
        btn.className = 'tm-key tm-key-emergency long-press-active';
        btn.textContent = '紧急按钮';
        btn.setAttribute('aria-label', '紧急按钮');
    }
}

function renderEmergencyHoldCountdown(secondsLeft) {
    const btn = document.getElementById('btn-status-5');
    if (!btn) return;
    btn.className = 'tm-key tm-key-emergency is-holding long-press-active';
    btn.innerHTML = '<span class="tm-emg-hold"><span class="tm-emg-hold-label">继续按下</span><span class="tm-emg-hold-num">' + secondsLeft + '</span></span>';
    btn.setAttribute('aria-label', '继续按下 ' + secondsLeft);
}

function bindEmergencyLongPress() {
    const btn = document.getElementById('btn-status-5');
    if (!btn) return;

    let countdownTimer = null;
    let secondsLeft = 0;
    let ignoreNextClick = false;

    const clearHold = () => {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        secondsLeft = 0;
        isEmergencyHolding = false;
        btn.classList.remove('scale-95', 'opacity-80');
    };

    const startPress = (e) => {
        if (isEmergencyActive || isEmergencyHolding) return;
        if (e.type === 'touchstart' && e.cancelable) e.preventDefault();

        clearHold();
        isEmergencyHolding = true;
        secondsLeft = 3;
        renderEmergencyHoldCountdown(secondsLeft);
        btn.classList.add('scale-95', 'opacity-80');

        countdownTimer = setInterval(() => {
            secondsLeft -= 1;
            if (secondsLeft <= 0) {
                clearHold();
                ignoreNextClick = true;
                if (!currentUser) return;
                emitReliable('trigger_emergency', { userId: currentUser.id }, {
                    priority: 'high',
                    label: '紧急报警',
                    onQueued: function () {
                        applyOptimisticStatus(5, myCurrentEventId);
                        showTmNotice('网络不稳，紧急报警已优先加入本地队列，恢复后立即回传。', '已入队');
                    }
                });
                if (!linkIsOnline()) applyOptimisticStatus(5, myCurrentEventId);
                return;
            }
            renderEmergencyHoldCountdown(secondsLeft);
        }, 1000);
    };

    const cancelPress = () => {
        if (isEmergencyActive) return;
        if (!isEmergencyHolding) return;
        clearHold();
        updateEmergencyButtonUI();
    };

    btn.addEventListener('click', async (e) => {
        if (ignoreNextClick) {
            ignoreNextClick = false;
            e.preventDefault();
            return;
        }
        if (!isEmergencyActive) return;
        e.preventDefault();
        const ok = await showTmConfirm('确定取消紧急报警？取消后将恢复待命状态。', {
            title: '取消紧急',
            okText: '取消紧急',
            danger: true
        });
        if (!ok || !currentUser) return;
        emitReliable('cancel_emergency', { userId: currentUser.id }, {
            priority: 'high',
            label: '取消紧急',
            onQueued: function () {
                applyOptimisticStatus(1, null);
                showTmNotice('网络不稳，取消紧急已加入本地队列。', '已入队');
            }
        });
        if (!linkIsOnline()) applyOptimisticStatus(1, null);
    });

    btn.oncontextmenu = (e) => e.preventDefault();
    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('mouseup', cancelPress);
    btn.addEventListener('mouseleave', cancelPress);
    btn.addEventListener('touchstart', startPress, { passive: false });
    btn.addEventListener('touchend', cancelPress);
    btn.addEventListener('touchcancel', cancelPress);
}

function openSelectEventModal() {
    const listEl = document.getElementById('select-event-list');
    const modal = document.getElementById('modal-select-event');
    // 只展示未完成的事件
    const activeEvents = allEvents.filter(ev => ev.status === '未完成');

    if (activeEvents.length === 0) {
        listEl.innerHTML = '<div class="text-center text-gray-500 py-4">当前暂无未完成的事件</div>';
    } else {
        listEl.innerHTML = activeEvents.map(ev => {
            const priorityBadge = ev.priority === 1 ? '<span class="text-xs bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded">高优先级</span>' :
                                  (ev.priority === 2 ? '<span class="text-xs bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded">中优先级</span>' :
                                                       '<span class="text-xs bg-green-100 text-green-700 font-bold px-2 py-0.5 rounded">低优先级</span>');
            return `
                <label class="flex items-start p-3 border rounded-lg cursor-pointer hover:bg-blue-50 transition">
                    <input type="radio" name="selected_event" value="${ev.id}" class="mt-1 text-blue-600 focus:ring-blue-500">
                    <div class="ml-3">
                        <div class="font-bold text-gray-800 text-sm">${escapeHtml(ev.title)} ${priorityBadge}</div>
                        <div class="text-xs text-gray-600 mt-1">${escapeHtml(ev.description)}</div>
                    </div>
                </label>
            `;
        }).join('');
    }
    modal.classList.remove('hidden');
}

function bindEventModalControls() {
    document.getElementById('btn-close-event-modal').addEventListener('click', () => {
        document.getElementById('modal-select-event').classList.add('hidden');
    });

    document.getElementById('btn-confirm-select-event').addEventListener('click', () => {
        const selected = document.querySelector('input[name="selected_event"]:checked');
        if (!selected) {
            showTmNotice('请勾选一个事件');
            return;
        }
        changeStatus(3, parseInt(selected.value));
        document.getElementById('modal-select-event').classList.add('hidden');
    });
}

function bindAddEventForm() {
    const btnOpen = document.getElementById('btn-open-add-event');
    const modal = document.getElementById('modal-add-event');
    const btnClose = document.getElementById('btn-close-add-modal');
    const form = document.getElementById('form-add-event');

    btnOpen.addEventListener('click', () => modal.classList.remove('hidden'));
    btnClose.addEventListener('click', () => modal.classList.add('hidden'));

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = document.getElementById('event-title').value.trim();
        const contactEl = document.getElementById('event-contact');
        const detailsEl = document.getElementById('event-details');
        const legacyDescEl = document.getElementById('event-desc');
        const priority = parseInt(document.getElementById('event-priority').value, 10);

        let contact = '';
        let details = '';
        if (contactEl && detailsEl) {
            contact = contactEl.value.trim();
            details = detailsEl.value.trim();
        } else if (legacyDescEl) {
            details = legacyDescEl.value.trim();
            contact = '未填写';
        }
        if (!title || !details) {
            showTmNotice('请填写事件地点和详细情况');
            return;
        }

        const publish = async (force) => {
            const result = await emitReliable(
                'add_event',
                { title, contact, details, priority, force: !!force },
                {
                    withAck: true,
                    label: '上报事件',
                    onQueued: function () {
                        form.reset();
                        modal.classList.add('hidden');
                        showTmNotice('网络不稳，事件已加入本地队列，恢复后自动上报。', '已入队');
                    }
                }
            );
            if (result && result.queued) return;
            const resp = result && result.resp;
            if (resp && resp.duplicate) {
                const ok = await showTmConfirm((resp.message || '检测到可能重复的事件') + '\n\n确定仍要提交吗？', {
                    title: '可能重复',
                    okText: '仍要提交'
                });
                if (ok) publish(true);
                return;
            }
            if (resp && resp.success === false) {
                showTmNotice(resp.message || '提交失败');
                return;
            }
            form.reset();
            modal.classList.add('hidden');
            showTmNotice('事件上报成功', '提交成功');
        };
        publish(false);
    });
}