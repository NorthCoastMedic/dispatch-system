import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(path.join(process.env.TEMP, 'agpsd-tool/package.json'));
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { initializeCanvas, writePsdBuffer } = require('ag-psd');

initializeCanvas((w, h) => createCanvas(w, h));
GlobalFonts.registerFromPath('C:/Windows/Fonts/HarmonyOS_Sans_SC_Bold.ttf', 'HarmonyOS Sans SC');

const DIR = fs.readFileSync('H:/dispatch-system/tool/_passdir.txt', 'utf8').trim();
const W = 1276;
const H = 2022;
const S = 8.400198186780832;
const FONT_PS = 'HarmonyOS_Sans_SC_Bold';
const FONT = 'HarmonyOS Sans SC';
const INK = { r: 20, g: 20, b: 20 };
const RADIUS = Math.round((3.18 / 25.4) * 600);
const STROKE = 3;

const TITLE = '使用说明';
const FOOTER = '北岸安迅救援 制发';
const ITEMS = [
  '1. 本证为北岸安迅救援活动现场工作凭证，仅证明持证人受本组织派遣，在指定活动、指定区域提供急救与安全支持，不作为社会紧急救援或行政证件。',
  '2. 持证人须将本证佩戴于胸前显著位置，进入场地、接受主办方或安保查验时主动出示。',
  '3. 本证仅限本人使用，不得转借、涂改、复制；超出授权时间、场地无效。',
  '4. 证件遗失、损坏或被拾获，请扫描本证二维码，点击「报失」。挂失后扫码将不再显示队员档案。',
  '5. 须遵守活动现场安全规定及本组织调度；活动结束后交还本证。违反规定的，组织有权收回。'
];

function pt(px) {
  return px / S;
}

function wrap(ctx, text, maxW) {
  const chars = [...text];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxW) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function solid(color) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return c;
}

function textLayer(name, text, left, top, boxW, boxH, fontPx, tracking, align) {
  const canvas = createCanvas(boxW, boxH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${INK.r},${INK.g},${INK.b})`;
  ctx.font = `${fontPx}px "${FONT}"`;
  ctx.textAlign = align === 'center' ? 'center' : 'left';
  ctx.textBaseline = 'top';
  const maxW = boxW - 8;
  const lines = wrap(ctx, text, maxW);
  const leading = Math.round(fontPx * 1.42);
  let y = 8;
  const x = align === 'center' ? boxW / 2 : 4;
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += leading;
  }
  return {
    name,
    left,
    top,
    right: left + boxW,
    bottom: top + boxH,
    blendMode: 'normal',
    opacity: 1,
    canvas,
    text: {
      text,
      transform: [S, 0, 0, S, left, top],
      antiAlias: 'sharp',
      orientation: 'horizontal',
      shapeType: 'box',
      boxBounds: [0, 0, pt(boxW), pt(boxH)],
      paragraphStyle: { justification: align === 'center' ? 'center' : 'left' },
      style: {
        font: { name: FONT_PS, script: 0, type: 0, synthetic: 0 },
        fontSize: pt(fontPx),
        tracking: tracking || 0,
        autoKerning: true,
        fillColor: INK,
        leading: pt(fontPx * 1.42),
        autoLeading: false
      }
    }
  };
}

function dieLayer() {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  const inset = STROKE / 2;
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = STROKE;
  ctx.lineJoin = 'round';
  roundRect(ctx, inset, inset, W - STROKE, H - STROKE, Math.max(0, RADIUS - inset));
  ctx.stroke();
  return {
    name: '刀线-CR80外沿-圆角R3.18mm（印刷请隐藏）',
    left: 0,
    top: 0,
    right: W,
    bottom: H,
    blendMode: 'normal',
    opacity: 1,
    canvas: c
  };
}

function watermarkLayer() {
  const targetW = 780;
  const targetH = Math.round(targetW * logo.height / logo.width);
  const gray = createCanvas(targetW, targetH);
  const gctx = gray.getContext('2d');
  gctx.drawImage(logo, 0, 0, targetW, targetH);
  const img = gctx.getImageData(0, 0, targetW, targetH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  gctx.putImageData(img, 0, 0);
  const left = Math.round((W - targetW) / 2);
  const top = Math.round((H - targetH) / 2 + 20);
  return {
    name: '水印-圆标',
    left,
    top,
    right: left + targetW,
    bottom: top + targetH,
    blendMode: 'normal',
    opacity: 0.14,
    canvas: gray
  };
}

function measureBoxH(text, boxW, fontPx) {
  const canvas = createCanvas(8, 8);
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontPx}px "${FONT}"`;
  const lines = wrap(ctx, text, boxW - 8);
  const leading = Math.round(fontPx * 1.42);
  return 8 + lines.length * leading + 12;
}

const logo = await loadImage(path.join(DIR, '商标-圆标.png'));
const side = 78;
const bodyW = W - side * 2;
const bodyPx = 42;
const layers = [];
layers.push({ name: '底色', left: 0, top: 0, right: W, bottom: H, canvas: solid('#ffffff') });
layers.push(watermarkLayer());
layers.push(textLayer('标题', TITLE, side, 88, bodyW, 110, 80, 80, 'center'));

let y = 230;
const gap = 18;
for (let i = 0; i < ITEMS.length; i++) {
  const itemH = measureBoxH(ITEMS[i], bodyW, bodyPx);
  layers.push(textLayer('条款' + (i + 1), ITEMS[i], side, y, bodyW, itemH, bodyPx, 20, 'left'));
  y += itemH + gap;
}

layers.push(textLayer('制发', FOOTER, side, 1860, bodyW, 80, 36, 40, 'center'));
layers.push(dieLayer());

const psd = {
  width: W,
  height: H,
  imageResources: {
    resolutionInfo: {
      horizontalResolution: 600,
      horizontalResolutionUnit: 'PPI',
      widthUnit: 'Centimeters',
      verticalResolution: 600,
      verticalResolutionUnit: 'PPI',
      heightUnit: 'Centimeters'
    }
  },
  children: layers
};

const out = path.join(DIR, '通行证背面.psd');
fs.writeFileSync(out, writePsdBuffer(psd, { invalidateTextLayers: true, generateThumbnail: true }));

const preview = createCanvas(W, H);
const pctx = preview.getContext('2d');
for (const l of layers) {
  if (l.hidden || !l.canvas) continue;
  pctx.globalAlpha = l.opacity == null ? 1 : l.opacity;
  pctx.drawImage(l.canvas, l.left || 0, l.top || 0);
}
fs.writeFileSync(path.join(DIR, '通行证背面-预览.png'), preview.toBuffer('image/png'));
console.log('wrote', out);
