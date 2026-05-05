import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.cwd();
const rendererAssetDir = path.join(root, "src", "renderer", "assets");
const iconDir = path.join(root, "build", "icons");
const rendererSvgPath = path.join(rendererAssetDir, "iwara-tv-mark.svg");
const iconSvgPath = path.join(iconDir, "icon.svg");
const iconPngPath = path.join(iconDir, "icon.png");
const iconIcoPath = path.join(iconDir, "icon.ico");

const sizes = [16, 24, 32, 48, 64, 128, 256];
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

fs.mkdirSync(rendererAssetDir, { recursive: true });
fs.mkdirSync(iconDir, { recursive: true });

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">IwaraTV mark</title>
  <desc id="desc">A dark rounded app icon with a teal video frame, warm play mark, and small coral signal dot.</desc>
  <defs>
    <linearGradient id="bg" x1="128" y1="80" x2="896" y2="944" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#22282d"/>
      <stop offset="1" stop-color="#0f1115"/>
    </linearGradient>
    <linearGradient id="frame" x1="176" y1="146" x2="848" y2="878" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2c8478"/>
      <stop offset="1" stop-color="#244a52"/>
    </linearGradient>
    <linearGradient id="screen" x1="218" y1="198" x2="802" y2="832" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1b2228"/>
      <stop offset="1" stop-color="#101216"/>
    </linearGradient>
    <linearGradient id="gold" x1="308" y1="250" x2="718" y2="766" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f6d179"/>
      <stop offset="1" stop-color="#dfad46"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#bg)"/>
  <rect x="136" y="152" width="752" height="720" rx="184" fill="url(#frame)"/>
  <rect x="178" y="192" width="668" height="640" rx="148" fill="url(#screen)"/>
  <rect x="226" y="220" width="572" height="28" rx="14" fill="#ffffff" opacity=".12"/>
  <path d="M334 196a64 64 0 1 1 0 128 64 64 0 0 1 0-128Z" fill="url(#gold)"/>
  <rect x="278" y="338" width="112" height="386" rx="56" fill="url(#gold)"/>
  <path d="M474 318 474 706 774 512Z" fill="#080a0d" opacity=".28" transform="translate(20 24)"/>
  <path d="M458 306 458 718 780 512Z" fill="url(#gold)"/>
  <circle cx="742" cy="284" r="40" fill="#ed735f"/>
  <circle cx="792" cy="336" r="16" fill="#52bda8"/>
</svg>
`;

fs.writeFileSync(rendererSvgPath, svg);
fs.writeFileSync(iconSvgPath, svg);

const pngs = sizes.map((size) => ({ size, data: renderPng(size) }));
fs.writeFileSync(iconPngPath, pngs.find((item) => item.size === 256).data);
fs.writeFileSync(iconIcoPath, makeIco(pngs));

console.log(`Generated ${path.relative(root, rendererSvgPath)}`);
console.log(`Generated ${path.relative(root, iconPngPath)}`);
console.log(`Generated ${path.relative(root, iconIcoPath)}`);

function renderPng(size) {
  const ss = size < 48 ? 6 : 4;
  const width = size * ss;
  const height = size * ss;
  const scale = width / 1024;
  const high = new Uint8ClampedArray(width * height * 4);

  const c = (value) => value * scale;
  fillRoundRect(high, width, height, c(64), c(64), c(896), c(896), c(220), hex("#22282d"), hex("#0f1115"));
  fillRoundRect(high, width, height, c(136), c(152), c(752), c(720), c(184), hex("#2c8478"), hex("#244a52"));
  fillRoundRect(high, width, height, c(178), c(192), c(668), c(640), c(148), hex("#1b2228"), hex("#101216"));
  fillRoundRect(high, width, height, c(226), c(220), c(572), c(28), c(14), [255, 255, 255, 31]);
  fillCircle(high, width, height, c(334), c(260), c(64), hex("#f2c96f"), hex("#dfad46"));
  fillRoundRect(high, width, height, c(278), c(338), c(112), c(386), c(56), hex("#f2c96f"), hex("#dfad46"));
  fillPolygon(
    high,
    width,
    height,
    [
      [c(494), c(342)],
      [c(494), c(730)],
      [c(794), c(536)]
    ],
    [8, 10, 13, 72]
  );
  fillPolygon(
    high,
    width,
    height,
    [
      [c(458), c(306)],
      [c(458), c(718)],
      [c(780), c(512)]
    ],
    hex("#f4cf76")
  );
  fillCircle(high, width, height, c(742), c(284), c(40), hex("#ed735f"));
  fillCircle(high, width, height, c(792), c(336), c(16), hex("#52bda8"));

  const rgba = downsample(high, width, height, ss);
  return encodePng(size, size, rgba);
}

function fillRoundRect(buffer, width, height, x, y, w, h, r, top, bottom = top) {
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(width, Math.ceil(x + w));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(height, Math.ceil(y + h));

  for (let py = minY; py < maxY; py += 1) {
    const t = h <= 1 ? 0 : (py - y) / h;
    const color = mix(top, bottom, clamp(t, 0, 1));
    for (let px = minX; px < maxX; px += 1) {
      if (roundRectDistance(px + 0.5, py + 0.5, x, y, w, h, r) <= 0) {
        blend(buffer, width, px, py, color);
      }
    }
  }
}

function fillCircle(buffer, width, height, cx, cy, radius, top, bottom = top) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height, Math.ceil(cy + radius));
  const rr = radius * radius;

  for (let py = minY; py < maxY; py += 1) {
    const t = (py - (cy - radius)) / (radius * 2);
    const color = mix(top, bottom, clamp(t, 0, 1));
    for (let px = minX; px < maxX; px += 1) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= rr) {
        blend(buffer, width, px, py, color);
      }
    }
  }
}

function fillPolygon(buffer, width, height, points, color) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(width, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(height, Math.ceil(Math.max(...ys)));

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      if (pointInPolygon(px + 0.5, py + 0.5, points)) {
        blend(buffer, width, px, py, color);
      }
    }
  }
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function roundRectDistance(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

function blend(buffer, width, x, y, color) {
  const index = (y * width + x) * 4;
  const alpha = color[3] / 255;
  const dstAlpha = buffer[index + 3] / 255;
  const outAlpha = alpha + dstAlpha * (1 - alpha);

  if (outAlpha <= 0) {
    return;
  }

  buffer[index] = Math.round((color[0] * alpha + buffer[index] * dstAlpha * (1 - alpha)) / outAlpha);
  buffer[index + 1] = Math.round((color[1] * alpha + buffer[index + 1] * dstAlpha * (1 - alpha)) / outAlpha);
  buffer[index + 2] = Math.round((color[2] * alpha + buffer[index + 2] * dstAlpha * (1 - alpha)) / outAlpha);
  buffer[index + 3] = Math.round(outAlpha * 255);
}

function downsample(high, width, height, ss) {
  const outWidth = width / ss;
  const outHeight = height / ss;
  const out = Buffer.alloc(outWidth * outHeight * 4);

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let oy = 0; oy < ss; oy += 1) {
        for (let ox = 0; ox < ss; ox += 1) {
          const index = ((y * ss + oy) * width + x * ss + ox) * 4;
          r += high[index];
          g += high[index + 1];
          b += high[index + 2];
          a += high[index + 3];
        }
      }
      const count = ss * ss;
      const outIndex = (y * outWidth + x) * 4;
      out[outIndex] = Math.round(r / count);
      out[outIndex + 1] = Math.round(g / count);
      out[outIndex + 2] = Math.round(b / count);
      out[outIndex + 3] = Math.round(a / count);
    }
  }

  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeIco(images) {
  const headerSize = 6 + images.length * 16;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const entryOffset = 6 + index * 16;
    header[entryOffset] = image.size >= 256 ? 0 : image.size;
    header[entryOffset + 1] = image.size >= 256 ? 0 : image.size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.data.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

function hex(value) {
  const clean = value.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
    255
  ];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t)
  ];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
