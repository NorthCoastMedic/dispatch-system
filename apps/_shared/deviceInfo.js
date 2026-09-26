'use strict';

function clientIp(req, trustProxy) {
    if (trustProxy) {
        const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
        if (xf) return String(xf).split(',')[0].trim().slice(0, 64);
    }
    const addr = (req.socket && req.socket.remoteAddress) || '';
    return String(addr || '0.0.0.0').slice(0, 64);
}

function parseDevice(req) {
    const ua = String((req.headers && req.headers['user-agent']) || '').slice(0, 512);
    const platHdr = String((req.headers && req.headers['sec-ch-ua-platform']) || '').replace(/"/g, '').trim();
    const mobileHdr = String((req.headers && req.headers['sec-ch-ua-mobile']) || '');
    let browser = '未知浏览器';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/MicroMessenger/i.test(ua)) browser = '微信';
    let os = platHdr || '';
    if (!os) {
        if (/Windows NT/i.test(ua)) os = 'Windows';
        else if (/Android/i.test(ua)) os = 'Android';
        else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
        else if (/Mac OS X/i.test(ua)) os = 'macOS';
        else if (/Linux/i.test(ua)) os = 'Linux';
        else os = '未知系统';
    }
    const mobile = mobileHdr === '?1' || /Mobile|Android|iPhone|iPad/i.test(ua);
    const kind = mobile ? '移动端' : '桌面端';
    return {
        ip: '',
        userAgent: ua,
        device: kind + ' · ' + os + ' · ' + browser
    };
}

function fromReq(req, trustProxy) {
    const d = parseDevice(req);
    d.ip = clientIp(req, trustProxy);
    return d;
}

module.exports = { clientIp, parseDevice, fromReq };
