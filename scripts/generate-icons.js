#!/usr/bin/env node
/**
 * CryoClaw 图标生成脚本（纯 Node，无第三方依赖）
 *
 * 标识：尖顶六边形冰晶（冰蓝渐变 #7DD3FC → #0284C7）+ 三道爪痕负空间。
 * 主图标为深色圆角方底（#075985 → #0C4A6E）；macOS Template 为纯黑 + alpha。
 *
 * 光栅化：SDF（多边形/锥形贝塞尔爪痕）+ 超采样盒式降采样，边缘平滑。
 * 编码：手写 PNG（zlib deflate）、ICO（内嵌 PNG，Vista+）、ICNS（ic07–ic12 内嵌 PNG）。
 *
 * 用法：node scripts/generate-icons.js   （幂等，直接覆盖 assets/ 同名文件）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const PREVIEW_DIR = path.join(ROOT, ".cache", "icon-preview");

// ---------------------------------------------------------------- 颜色工具

function hexColor(s) {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lerp = (a, b, t) => a + (b - a) * t;
function mixColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

const COLORS = {
  bgTop: hexColor("#075985"),
  bgBottom: hexColor("#0C4A6E"),
  crystalTop: hexColor("#7DD3FC"),
  crystalBottom: hexColor("#0284C7"),
  trayDark: hexColor("#0C4A6E"), // 浅色任务栏用深色剪影
  trayLight: hexColor("#F0F9FF"), // 深色任务栏用浅色剪影
  template: hexColor("#000000"), // macOS 模板：纯黑 + alpha
};

// ---------------------------------------------------------------- SDF 基础

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 带符号多边形距离（内部为负），verts 为 [x,y] 数组 */
function sdPolygon(px, py, verts) {
  const n = verts.length;
  let s = 1;
  let minD2 = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vix = verts[i][0], viy = verts[i][1];
    const vjx = verts[j][0], vjy = verts[j][1];
    const ex = vjx - vix, ey = vjy - viy;
    const wx = px - vix, wy = py - viy;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t, by = wy - ey * t;
    const d2 = bx * bx + by * by;
    const c1 = py >= viy, c2 = py < vjy, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    if (d2 < minD2) minD2 = d2;
  }
  return s * Math.sqrt(minD2);
}

/** 圆角矩形 SDF（中心原点，hx/hy 半尺寸，r 圆角） */
function sdRoundedBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 尖顶六边形顶点（y 向下，顶/底为尖角） */
function hexagonVerts(R) {
  const v = [];
  for (let k = 0; k < 6; k++) {
    const a = ((-90 + 60 * k) * Math.PI) / 180;
    v.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return v;
}

/** 二次贝塞尔采样为折线的锥形爪痕（粗端 r0 → 细端 r1） */
function makeClaw(p0, p1, p2, r0, r1, segs = 24) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  const rMax = Math.max(r0, r1);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { pts, r0, r1, bbox: [minX - rMax, minY - rMax, maxX + rMax, maxY + rMax] };
}

function sdClaw(px, py, claw) {
  const [bx0, by0, bx1, by1] = claw.bbox;
  if (px < bx0 || px > bx1 || py < by0 || py > by1) return Infinity;
  const { pts, r0, r1 } = claw;
  const n = pts.length - 1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = pts[i][0], ay = pts[i][1];
    const ex = pts[i + 1][0] - ax, ey = pts[i + 1][1] - ay;
    const wx = px - ax, wy = py - ay;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1e-9), 0, 1);
    const dx = wx - ex * t, dy = wy - ey * t;
    const rSeg = lerp(r0, r1, (i + t) / n); // 沿曲线锥形变细
    const d = Math.hypot(dx, dy) - rSeg;
    if (d < best) best = d;
  }
  return best;
}

/** 覆盖率：SDF → alpha（d 以渲染像素为单位，负值在形状内部） */
function coverage(d) {
  return clamp(0.5 - d, 0, 1);
}

// ---------------------------------------------------------------- 场景定义

/**
 * 三道爪痕（归一化坐标，1 = 冰晶外接圆半径，y 向下；粗端在下，尖细端上挑）。
 * 爪痕允许超出冰晶边界——擦除时会被内缩冰晶裁剪，保留完整六边形轮廓。
 */
function makeClaws(scale, thick) {
  const claws = [];
  const offsets = [-0.56, 0, 0.56];
  for (const ox of offsets) {
    claws.push(
      makeClaw(
        [(ox - 0.52) * scale, 0.98 * scale], // 粗端（左下）
        [(ox - 0.14) * scale, 0.10 * scale], // 控制点：弯出爪弧
        [(ox + 0.52) * scale, -0.98 * scale], // 细端（右上挑）
        thick * scale,
        thick * 0.28 * scale
      )
    );
  }
  return claws;
}

/**
 * 场景采样：返回 [r,g,b,a]（0-255，非预乘）
 * @param mode "app" 主图标（深色底+渐变冰晶）| "glyph" 纯色剪影（托盘用）
 * @param simplified 小尺寸变体：冰晶更大、爪痕更粗
 */
function makeScene(size, mode, glyphColor, simplified) {
  const cx = size / 2, cy = size / 2;
  const bgHalf = size / 2;
  const bgRadius = size * 0.225;
  const hexR = size * (simplified ? 0.43 : 0.345);
  const verts = hexagonVerts(hexR);
  const clawThick = simplified ? 0.19 : 0.16;
  const claws = makeClaws(hexR, clawThick);
  // 爪痕擦除范围限制在内缩冰晶内，外圈保留一圈冰晶描边，六边形轮廓完整
  const innerVerts = hexagonVerts(hexR * (simplified ? 0.84 : 0.88));

  return (x, y) => {
    const px = x - cx, py = y - cy;
    // 背景层
    let r = 0, g = 0, b = 0, a = 0;
    if (mode === "app") {
      const aBg = coverage(sdRoundedBox(px, py, bgHalf, bgHalf, bgRadius));
      if (aBg > 0) {
        const [cr, cg, cb] = mixColor(COLORS.bgTop, COLORS.bgBottom, clamp(y / size, 0, 1));
        r = cr; g = cg; b = cb; a = aBg;
      }
    }
    // 冰晶层（爪痕负空间擦除，限制在内缩冰晶内以保留轮廓描边）
    const aHex = coverage(sdPolygon(px, py, verts));
    if (aHex > 0) {
      const aClip = coverage(sdPolygon(px, py, innerVerts));
      let aErase = 0;
      for (const claw of claws) aErase = Math.max(aErase, coverage(sdClaw(px, py, claw)));
      aErase *= aClip;
      const aMark = aHex * (1 - aErase);
      if (aMark > 0) {
        const t = clamp(py / hexR / 2 + 0.5, 0, 1);
        const [cr, cg, cb] =
          mode === "app" ? mixColor(COLORS.crystalTop, COLORS.crystalBottom, t) : glyphColor;
        // "over" 合成到背景上
        const outA = aMark + a * (1 - aMark);
        if (outA > 0) {
          r = (cr * aMark + r * a * (1 - aMark)) / outA;
          g = (cg * aMark + g * a * (1 - aMark)) / outA;
          b = (cb * aMark + b * a * (1 - aMark)) / outA;
          a = outA;
        }
      }
    }
    return [r, g, b, a];
  };
}

// ---------------------------------------------------------------- 光栅化

/** 超采样渲染 + 盒式降采样，返回 RGBA Buffer（size×size×4） */
function render(size, scene, ss) {
  const big = size * ss;
  const out = Buffer.alloc(size * size * 4);
  // 超采样网格逐子像素求 alpha 加权平均（预乘）
  const grid = Buffer.alloc(big * big * 4);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const [r, g, b, a] = scene((x + 0.5) / ss, (y + 0.5) / ss);
      const o = (y * big + x) * 4;
      grid[o] = r * a; grid[o + 1] = g * a; grid[o + 2] = b * a; grid[o + 3] = a * 255;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const o = ((y * ss + dy) * big + (x * ss + dx)) * 4;
          sr += grid[o]; sg += grid[o + 1]; sb += grid[o + 2]; sa += grid[o + 3];
        }
      }
      const n = ss * ss;
      const a = sa / n / 255;
      const o = (y * size + x) * 4;
      if (a > 1e-4) {
        out[o] = Math.round(sr / n / a);
        out[o + 1] = Math.round(sg / n / a);
        out[o + 2] = Math.round(sb / n / a);
      }
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function renderIcon(size, mode, glyphColor) {
  const simplified = size <= 64;
  const ss = size >= 512 ? 2 : size >= 128 ? 4 : 8;
  return render(size, makeScene(size, mode, glyphColor, simplified), ss);
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 滤波器 0（None），逐行加前导字节
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO / ICNS

/** ICO：全部尺寸内嵌 PNG（Vista+ 格式） */
function encodeICO(entries) {
  // entries: [{size, png}]
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // 类型：图标
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const parts = [dir];
  entries.forEach(({ size, png }, i) => {
    const o = 6 + i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // 调色板
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
    parts.push(png);
  });
  return Buffer.concat(parts);
}

/** ICNS：PNG 数据块（ic07=128, ic08=256, ic09=512, ic10=1024, ic11=32, ic12=64） */
function encodeICNS(entries) {
  // entries: [{type, png}]
  const parts = [];
  let total = 8;
  for (const { type, png } of entries) {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + png.length, 4);
    parts.push(head, png);
    total += 8 + png.length;
  }
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...parts]);
}

// ---------------------------------------------------------------- 预览工具

/** 最近邻放大，便于人工检查小尺寸图标 */
function upscaleNearest(rgba, size, factor) {
  const big = size * factor;
  const out = Buffer.alloc(big * big * 4);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const so = ((y / factor | 0) * size + (x / factor | 0)) * 4;
      const o = (y * big + x) * 4;
      out[o] = rgba[so]; out[o + 1] = rgba[so + 1];
      out[o + 2] = rgba[so + 2]; out[o + 3] = rgba[so + 3];
    }
  }
  return out;
}

/** 主图标缩到小尺寸的辨识性预览（直接以目标尺寸渲染简化变体） */
function renderAppPreview(size) {
  return render(size, makeScene(size, "app", null, size <= 64), 8);
}

// ---------------------------------------------------------------- 主流程

function main() {
  const t0 = Date.now();
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const pngCache = new Map();
  const appPNG = (size) => {
    const key = `app-${size}`;
    if (!pngCache.has(key)) pngCache.set(key, encodePNG(size, size, renderIcon(size, "app", null)));
    return pngCache.get(key);
  };

  // 1) 主图标 icon.png（1024×1024）
  fs.writeFileSync(path.join(ASSETS, "icon.png"), appPNG(1024));
  console.log("icon.png 1024x1024");

  // 2) Windows icon.ico（16/24/32/48/64/128/256 内嵌 PNG）
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(
    path.join(ASSETS, "icon.ico"),
    encodeICO(icoSizes.map((s) => ({ size: s, png: appPNG(s) })))
  );
  console.log("icon.ico", icoSizes.join("/"));

  // 3) macOS icon.icns（ic07..ic12 内嵌 PNG）
  const icnsEntries = [
    { type: "ic11", size: 32 }, // 16x16@2x
    { type: "ic12", size: 64 }, // 32x32@2x
    { type: "ic07", size: 128 },
    { type: "ic08", size: 256 },
    { type: "ic09", size: 512 },
    { type: "ic10", size: 1024 },
  ];
  fs.writeFileSync(
    path.join(ASSETS, "icon.icns"),
    encodeICNS(icnsEntries.map(({ type, size }) => ({ type, png: appPNG(size) })))
  );
  console.log("icon.icns", icnsEntries.map((e) => e.type).join("/"));

  // 4) 托盘图标（16 + @2x 32，剪影式；模板为纯黑+alpha）
  const trayJobs = [
    ["tray-icon.png", 16, "glyph", COLORS.trayDark],
    ["tray-icon@2x.png", 32, "glyph", COLORS.trayDark],
    ["tray-icon-light.png", 16, "glyph", COLORS.trayLight],
    ["tray-icon-light@2x.png", 32, "glyph", COLORS.trayLight],
    ["tray-iconTemplate.png", 16, "glyph", COLORS.template],
    ["tray-iconTemplate@2x.png", 32, "glyph", COLORS.template],
  ];
  for (const [name, size, mode, color] of trayJobs) {
    const rgba = renderIcon(size, mode, color);
    fs.writeFileSync(path.join(ASSETS, name), encodePNG(size, size, rgba));
    // 预览：实际尺寸 + 8x 最近邻放大
    fs.writeFileSync(
      path.join(PREVIEW_DIR, name.replace(".png", "-x8.png")),
      encodePNG(size * 8, size * 8, upscaleNearest(rgba, size, 8))
    );
    console.log(name, `${size}x${size}`);
  }

  // 5) 主图标小尺寸辨识性预览（16/32/48 实际渲染 + 放大版）
  for (const size of [16, 32, 48]) {
    const rgba = renderAppPreview(size);
    fs.writeFileSync(path.join(PREVIEW_DIR, `app-${size}.png`), encodePNG(size, size, rgba));
    fs.writeFileSync(
      path.join(PREVIEW_DIR, `app-${size}-x8.png`),
      encodePNG(size * 8, size * 8, upscaleNearest(rgba, size, 8))
    );
  }
  console.log(`预览输出到 ${path.relative(ROOT, PREVIEW_DIR)}/`);
  console.log(`完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
