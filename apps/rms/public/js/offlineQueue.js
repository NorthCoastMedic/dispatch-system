/**
 * RMS 响应终端弱网队列（仅浏览器 localStorage，不改数据库）
 * 断网/Socket 断开时把操作入队，恢复后按序回传现有 socket 事件。
 */
(function (global) {
    var MAX_ITEMS = 40;
    var flushing = false;

    function storageKey(userId) {
        return 'rms_terminal_queue_v1_' + String(userId || '0');
    }

    function safeParse(raw) {
        try {
            var list = JSON.parse(raw);
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    function load(userId) {
        try {
            return safeParse(localStorage.getItem(storageKey(userId)) || '[]');
        } catch (e) {
            return [];
        }
    }

    function save(userId, list) {
        try {
            localStorage.setItem(storageKey(userId), JSON.stringify(list.slice(0, MAX_ITEMS)));
        } catch (e) { /* quota / private mode */ }
    }

    function isOnline(socket) {
        return !!(global.navigator && navigator.onLine !== false && socket && socket.connected);
    }

    function enqueue(userId, item) {
        var list = load(userId);
        if (item.coalesceKey) {
            list = list.filter(function (x) { return x.coalesceKey !== item.coalesceKey; });
        }
        var row = {
            id: String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8),
            event: item.event,
            data: item.data,
            priority: item.priority === 'high' ? 'high' : 'normal',
            coalesceKey: item.coalesceKey || null,
            label: item.label || item.event,
            ts: Date.now()
        };
        if (row.priority === 'high') list.unshift(row);
        else list.push(row);
        if (list.length > MAX_ITEMS) list = list.slice(0, MAX_ITEMS);
        save(userId, list);
        return list.length;
    }

    function count(userId) {
        return load(userId).length;
    }

    function clear(userId) {
        save(userId, []);
    }

    /**
     * 逐条 emit；带 ack 的等回调，超时则保留在队首稍后重试
     */
    function flush(userId, socket, onProgress) {
        if (flushing) return Promise.resolve({ flushed: 0, left: count(userId) });
        if (!isOnline(socket)) return Promise.resolve({ flushed: 0, left: count(userId) });

        flushing = true;
        var flushed = 0;

        function step() {
            var list = load(userId);
            if (!list.length || !isOnline(socket)) {
                flushing = false;
                if (typeof onProgress === 'function') onProgress(list.length);
                return Promise.resolve({ flushed: flushed, left: list.length });
            }

            var item = list[0];
            return new Promise(function (resolve) {
                var settled = false;
                var timer = setTimeout(function () {
                    if (settled) return;
                    settled = true;
                    // 超时：留在队列，结束本轮（避免死循环狂发）
                    flushing = false;
                    if (typeof onProgress === 'function') onProgress(load(userId).length);
                    resolve({ flushed: flushed, left: load(userId).length, timedOut: true });
                }, 10000);

                function doneOk() {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    var rest = load(userId).filter(function (x) { return x.id !== item.id; });
                    save(userId, rest);
                    flushed += 1;
                    if (typeof onProgress === 'function') onProgress(rest.length);
                    resolve(step());
                }

                try {
                    if (item.event === 'add_event' || item.event === 'accept_assign' || item.event === 'reject_assign') {
                        socket.emit(item.event, item.data, function () {
                            doneOk();
                        });
                    } else {
                        socket.emit(item.event, item.data);
                        // 无 ack 的指令：短延迟后视为已发出
                        setTimeout(doneOk, 120);
                    }
                } catch (e) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    flushing = false;
                    if (typeof onProgress === 'function') onProgress(load(userId).length);
                    resolve({ flushed: flushed, left: load(userId).length, error: true });
                }
            });
        }

        return step();
    }

    global.RmsOfflineQueue = {
        load: load,
        save: save,
        enqueue: enqueue,
        count: count,
        clear: clear,
        flush: flush,
        isOnline: isOnline
    };
})(window);
