function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function initHeader(currentUser) {
    const clockEl = document.getElementById('header-clock');
    if (clockEl) {
        setInterval(() => {
            const now = new Date();
            clockEl.innerText = now.toLocaleString('zh-CN', {
                hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        }, 1000);
    }

    const nameBtn = document.getElementById('username-btn');
    const dropdown = document.getElementById('user-dropdown');
    if (nameBtn && dropdown && currentUser) {
        document.getElementById('header-username').innerText = currentUser.username;
        nameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('hidden');
        });
        document.addEventListener('click', () => dropdown.classList.add('hidden'));
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            const data = await res.json();
            if (data.success) window.location.href = '/login.php';
        });
    }
}

function resolveAlarmAudio() {
    const alarmAudio = document.getElementById('alarm-audio');
    if (!alarmAudio) return null;
    const src = alarmAudio.getAttribute('src') || '';
    // 历史错误：写了站点根路径 /sounds/...，实际文件在 /rms/sounds/
    if (src === '/sounds/alarm.mp3' || src.indexOf('/sounds/') === 0) {
        const base = (window.Platform && window.Platform.base) || '/rms';
        alarmAudio.setAttribute('src', base + '/sounds/alarm.mp3');
        try { alarmAudio.load(); } catch (_) { /* ignore */ }
    }
    return alarmAudio;
}

function playAlarmSound() {
    const alarmAudio = resolveAlarmAudio();
    if (!alarmAudio) return;
    try {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
    } catch (_) { /* ignore */ }
    const p = alarmAudio.play();
    if (p && typeof p.catch === 'function') {
        p.catch((err) => console.log('浏览器自动播放限制或音源不可用', err && err.message ? err.message : err));
    }
}

/** 解析单呼/广播用提示音（绝对路径，避免相对路径在 /rms 下失败） */
function resolveMessageToneAudio() {
    let el = document.getElementById('message-tone');
    if (!el) {
        el = document.createElement('audio');
        el.id = 'message-tone';
        el.preload = 'auto';
        document.body.appendChild(el);
    }
    const base = (window.Platform && window.Platform.base) || '/rms';
    const want = base.replace(/\/$/, '') + '/sounds/event_tone.mp3';
    const cur = el.getAttribute('src') || '';
    if (cur !== want && cur.indexOf('/sounds/event_tone.mp3') === -1) {
        el.setAttribute('src', want);
        try { el.load(); } catch (_) { /* ignore */ }
    }
    return el;
}

/** 成员终端：event_tone 只响一次（调度端不要调用） */
function playEventToneOnce() {
    const tone = resolveMessageToneAudio();
    if (!tone) return;
    try {
        tone.loop = false;
        tone.muted = false;
        tone.volume = 1;
        tone.pause();
        tone.currentTime = 0;
    } catch (_) { /* ignore */ }
    const p = tone.play();
    if (p && typeof p.catch === 'function') {
        p.catch((err) => {
            console.log('event_tone 播放失败（需先点击页面解锁音频）', err && err.message ? err.message : err);
            // 再试一次新建 Audio（部分浏览器对隐藏/未解锁节点更严）
            try {
                const base = (window.Platform && window.Platform.base) || '/rms';
                const a = new Audio(base.replace(/\/$/, '') + '/sounds/event_tone.mp3');
                a.loop = false;
                a.play().catch(() => {});
            } catch (_) { /* ignore */ }
        });
    }
}

// 用户手势后解锁音频（移动端/自动播放策略）
function unlockAlarmAudioOnce() {
    const alarmAudio = resolveAlarmAudio();
    const eventTone = document.getElementById('event-tone');
    const unlockOne = (el) => {
        if (!el || el.dataset.unlocked === '1') return;
        const prevVol = el.volume;
        el.muted = true;
        el.volume = 0;
        const p = el.play();
        const done = () => {
            try {
                el.pause();
                el.currentTime = 0;
                el.muted = false;
                el.volume = prevVol || 1;
                el.dataset.unlocked = '1';
            } catch (_) { /* ignore */ }
        };
        if (p && typeof p.then === 'function') p.then(done).catch(done);
        else done();
    };
    unlockOne(alarmAudio);
    unlockOne(eventTone);
    unlockOne(resolveMessageToneAudio());
    unlockOne(document.getElementById('sla-warn-tone'));
    unlockOne(document.getElementById('sla-timeout-tone'));
}

['pointerdown', 'touchstart', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, unlockAlarmAudioOnce, { once: true, passive: true });
});
// 终端上点状态按钮也再解锁一次，避免首屏未点到导致收不到音
document.addEventListener('click', () => {
    try { resolveMessageToneAudio(); } catch (_) { /* ignore */ }
    const tone = document.getElementById('message-tone');
    if (tone && tone.dataset.unlocked !== '1') unlockAlarmAudioOnce();
}, true);

function initEmergencyListener(socket, onAlertCallback) {
    if (!socket) return;

    socket.on('emergency_alert_broadcast', (data) => {
        playAlarmSound();
        if (onAlertCallback) onAlertCallback(data);
    });

    // 从往返缓存恢复时旧 sid 会 400，强制重连
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && socket && typeof socket.connect === 'function') {
            try {
                socket.disconnect();
                socket.connect();
            } catch (_) { /* ignore */ }
        }
    });
}
