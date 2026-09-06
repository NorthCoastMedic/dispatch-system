'use strict';

const crypto = require('crypto');
const readline = require('readline');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WAIT_MS = 5 * 60 * 1000;

let busy = false;

function isInteractive() {
    return !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
}

function randomCode(len) {
    const n = len || 10;
    const bytes = crypto.randomBytes(n);
    let out = '';
    for (let i = 0; i < n; i++) out += CHARSET[bytes[i] % CHARSET.length];
    return out;
}

function ask(rl, prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(String(answer || '').trim()));
    });
}

function withTimeout(promise, ms, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (typeof onTimeout === 'function') onTimeout();
            reject(new Error('终端确认超时'));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function confirmLogRetentionChange(detail) {
    if (busy) {
        return { ok: false, error: '已有一项终端确认进行中' };
    }
    if (!isInteractive()) {
        return {
            ok: false,
            error: '当前没有终端（请在 Windows CMD 或 Linux 终端前台运行），无法确认日志保留修改。'
        };
    }
    busy = true;
    let rl = null;
    try {
        if (typeof process.stdin.setEncoding === 'function') {
            process.stdin.setEncoding('utf8');
        }
        if (typeof process.stdin.resume === 'function') {
            process.stdin.resume();
        }
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
            crlfDelay: Infinity
        });

        const lines = [
            '',
            '========================================',
            ' 日志保留天数修改确认',
            '========================================',
            detail && detail.actor ? (' 操作人: ' + detail.actor) : '',
            detail && detail.summary ? (' 变更: ' + detail.summary) : '',
            ' 是否执行？请输入 y 或 n',
            '========================================'
        ].filter(Boolean);

        process.stdout.write(lines.join('\n') + '\n');

        const yn = await withTimeout(ask(rl, '确认 [y/n]: '), WAIT_MS, () => {
            try { rl.close(); } catch (_) { /* ignore */ }
        });
        if (!/^y(es)?$/i.test(yn)) {
            process.stdout.write('已取消。\n');
            return { ok: false, error: '已在服务器终端取消' };
        }

        const code = randomCode(10);
        process.stdout.write('\n请输入确认码（10 位，区分大小写）：\n  ' + code + '\n');
        const typed = await withTimeout(ask(rl, '确认码: '), WAIT_MS, () => {
            try { rl.close(); } catch (_) { /* ignore */ }
        });
        if (typed !== code) {
            process.stdout.write('确认码不正确，已拒绝。\n');
            return { ok: false, error: '确认码不正确' };
        }
        process.stdout.write('终端确认通过。\n');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message || '终端确认失败' };
    } finally {
        busy = false;
        try {
            if (rl) rl.close();
        } catch (_) { /* ignore */ }
    }
}

module.exports = {
    confirmLogRetentionChange,
    isInteractive,
    randomCode
};
