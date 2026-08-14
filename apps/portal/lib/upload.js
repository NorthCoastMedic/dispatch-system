const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CERT_DIR = path.join(__dirname, '..', 'certificates');
const AVATAR_DIR = path.join(__dirname, '..', 'avatars');
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'simhei.ttf');
const WATERMARK_TEXT = '仅限资质公开平台使用';
const DEFAULT_AVATAR_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2NjYyI+PHBhdGggZD0iTTEyIDJDMi4yNiAyIDIgMTIuMjYgMiAxMnMxMC4yNiAxMCAxMCAxMCAxMCAxMCAxMCAtMTAuMjYgMTAtMTBTMjEuNzQgMiAxMiAyem0wIDE0Yy0yLjY3IDAtOCAxLjM0LTggNHYxYzAgMS4xIDAuOSAyIDIgMmgxMmMxLjEgMCAyLTAuOSAyLTJ2LTFjMC0yLjY2LTUuMzMtNC04LTR6Ii8+PC9zdmc+';

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureCertDir() { ensureDir(CERT_DIR); }
function ensureAvatarDir() { ensureDir(AVATAR_DIR); }

/** 校验真实图片头：仅 JPEG / PNG */
function assertJpegOrPng(buffer, originalName) {
    if (!buffer || buffer.length < 8) {
        throw new Error('仅允许上传 JPG 或 PNG 图片');
    }
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
        && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
    if (!isJpeg && !isPng) {
        throw new Error('仅允许上传 JPG 或 PNG 图片');
    }
    const name = String(originalName || '').toLowerCase();
    if (name && !/\.(jpe?g|png)$/i.test(name)) {
        throw new Error('仅允许上传 JPG 或 PNG 图片');
    }
    return isPng ? 'png' : 'jpg';
}

/** 文件名安全片段 */
function sanitizeFilePart(value, maxLen) {
    const cleaned = String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned.slice(0, maxLen || 80) || '';
}

function buildNamedJpeg(badgeNumber, secondPart, prefix) {
    const badge = sanitizeFilePart(badgeNumber, 40);
    const part = sanitizeFilePart(secondPart, 80);
    if (badge && part) return `${badge}_${part}.jpg`;
    if (badge) return `${badge}_${Date.now()}.jpg`;
    if (part) return `${part}_${Date.now()}.jpg`;
    return `${prefix || 'file'}_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`;
}

function uniquePath(dir, fileName) {
    let finalName = fileName;
    let finalPath = path.join(dir, finalName);
    if (fs.existsSync(finalPath)) {
        const stem = finalName.replace(/\.jpg$/i, '');
        finalName = `${stem}_${Date.now().toString(36)}.jpg`;
        finalPath = path.join(dir, finalName);
    }
    return { fileName: finalName, finalPath };
}

function isRemoteAvatarUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

/** 页面展示用：本地文件走 get_avatar；旧直链仍可读 */
function publicAvatarUrl(stored) {
    const v = String(stored || '').trim();
    if (!v) return DEFAULT_AVATAR_DATA_URI;
    if (isRemoteAvatarUrl(v)) return v;
    return '/get_avatar.php?file=' + encodeURIComponent(path.basename(v));
}

/**
 * @param {object} file multer memory file
 * @param {{ badgeNumber?: string, certName?: string }} [meta]
 */
async function processAndSaveCertificate(file, meta) {
    ensureCertDir();
    if (!file || !file.buffer) return '';

    assertJpegOrPng(file.buffer, file.originalname);

    meta = meta || {};
    const built = uniquePath(CERT_DIR, buildNamedJpeg(meta.badgeNumber, meta.certName, 'cert'));
    const fileName = built.fileName;
    const finalPath = built.finalPath;

    // 先应用 EXIF 旋转并落成缓冲，再用真实宽高画水印，避免 composite 尺寸不一致
    const { data: rotatedBuf, info } = await sharp(file.buffer)
        .rotate()
        .toBuffer({ resolveWithObject: true });
    const width = info.width || 1200;
    const height = info.height || 800;

    const fontCss = fs.existsSync(FONT_PATH)
        ? `@font-face { font-family: 'SimHei'; src: url('file://${FONT_PATH.replace(/\\/g, '/')}'); }`
        : '';
    const fontFamily = fs.existsSync(FONT_PATH) ? 'SimHei' : 'sans-serif';
    const angle = -Math.atan2(height, width) * (180 / Math.PI);
    const fontSize = Math.max(26, Math.floor(Math.min(width, height) / 16));
    const step = Math.max(fontSize * 3.2, Math.min(width, height) / 3.5);

    const texts = [];
    for (let i = -2; i <= 2; i++) {
        const y = height / 2 + i * step;
        texts.push(
            `<text x="50%" y="${y}" text-anchor="middle" dominant-baseline="middle" class="wm">${WATERMARK_TEXT}</text>`
        );
    }

    const svg = Buffer.from(`
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <style>${fontCss}
          .wm {
            fill: rgba(180, 40, 40, 0.22);
            font-size: ${fontSize}px;
            font-family: '${fontFamily}', sans-serif;
            font-weight: bold;
            letter-spacing: 2px;
          }
        </style>
        <g transform="rotate(${angle} ${width / 2} ${height / 2})">
          ${texts.join('\n')}
        </g>
      </svg>
    `);

    // 强制把水印栅格化到与底图完全一致的尺寸，防止 SVG 渲染多出 1px
    const watermark = await sharp(svg)
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer();

    await sharp(rotatedBuf)
        .composite([{ input: watermark, top: 0, left: 0 }])
        .jpeg({ quality: 85 })
        .toFile(finalPath);

    return fileName;
}

/**
 * 头像：队员编号_姓名.jpg，仅 JPG/PNG，缩放到合理尺寸
 * @param {object} file
 * @param {{ badgeNumber?: string, personName?: string }} [meta]
 */
async function processAndSaveAvatar(file, meta) {
    ensureAvatarDir();
    if (!file || !file.buffer) return '';

    assertJpegOrPng(file.buffer, file.originalname);

    meta = meta || {};
    const built = uniquePath(AVATAR_DIR, buildNamedJpeg(meta.badgeNumber, meta.personName, 'avatar'));
    const fileName = built.fileName;
    const finalPath = built.finalPath;

    await sharp(file.buffer)
        .rotate()
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(finalPath);

    return fileName;
}

function deleteCertificateFile(fileName) {
    if (!fileName || isRemoteAvatarUrl(fileName)) return true;
    const clean = path.basename(String(fileName));
    const filePath = path.join(CERT_DIR, clean);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    }
    return true;
}

function deleteAvatarFile(fileName) {
    if (!fileName || isRemoteAvatarUrl(fileName)) return true;
    const clean = path.basename(String(fileName));
    const filePath = path.join(AVATAR_DIR, clean);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    }
    return true;
}

module.exports = {
    CERT_DIR,
    AVATAR_DIR,
    DEFAULT_AVATAR_DATA_URI,
    processAndSaveCertificate,
    processAndSaveAvatar,
    deleteCertificateFile,
    deleteAvatarFile,
    publicAvatarUrl,
    isRemoteAvatarUrl
};
