/**
 * 本机生成证件二维码 SVG，不访问外网、不调用在线二维码接口。
 * 算法文件在 ./vendor/qrcode（随平台一起分发）。
 */
'use strict';

const QRCode = require('./vendor/qrcode/lib/core/qrcode');
const SvgTag = require('./vendor/qrcode/lib/renderer/svg-tag');

function normalizeScanBase(raw) {
    let s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
}

function scanTarget(cardNo, scanBase) {
    const no = String(cardNo == null ? '' : cardNo).trim();
    const path = '/id_card.php?no=' + encodeURIComponent(no);
    const base = normalizeScanBase(scanBase);
    return base ? base + path : path;
}

function toSvg(text, opts) {
    const qr = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
    return SvgTag.render(qr, {
        margin: 1,
        width: (opts && opts.width) || 240
    });
}

function toDataUri(text, opts) {
    const svg = toSvg(text, opts);
    return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

module.exports = { toSvg, toDataUri, scanTarget, normalizeScanBase };
