#!/usr/bin/env node
/**
 * scripts/generate-icons.mjs
 * Generates VoxPilot extension icons as PNG files using pure Node.js (no canvas dep).
 * Writes minimal but valid PNG files at 16×16, 48×48, and 128×128 pixels.
 *
 * The icon is a purple/blue microphone on a dark background — VoxPilot brand colours.
 */

import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'src', 'icons');

mkdirSync(ICONS_DIR, { recursive: true });

const SIZES = [16, 48, 128];

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background — rounded rect (dark slate)
  const r = size * 0.18;
  ctx.fillStyle = '#0f172a';
  roundedRect(ctx, 0, 0, size, size, r);
  ctx.fill();

  // Accent gradient background
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.6);
  grad.addColorStop(0, 'rgba(37,99,235,0.35)');
  grad.addColorStop(1, 'rgba(37,99,235,0)');
  ctx.fillStyle = grad;
  roundedRect(ctx, 0, 0, size, size, r);
  ctx.fill();

  // Microphone body
  const cx = size / 2;
  const micW = size * 0.28;
  const micH = size * 0.38;
  const micY = size * 0.14;
  const micR = micW / 2;

  ctx.fillStyle = '#2563eb';
  ctx.beginPath();
  ctx.roundRect(cx - micW / 2, micY, micW, micH, [micR, micR, micR * 0.6, micR * 0.6]);
  ctx.fill();

  // Microphone arc (stand)
  const arcY = micY + micH * 0.6;
  const arcR = micW * 0.85;
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, arcY, arcR, Math.PI, 0);
  ctx.stroke();

  // Mic stand pole
  const poleTop = arcY;
  const poleBot = size * 0.86;
  ctx.beginPath();
  ctx.moveTo(cx, poleTop + arcR);
  ctx.lineTo(cx, poleBot);
  ctx.stroke();

  // Mic stand base
  const baseW = micW * 1.1;
  ctx.beginPath();
  ctx.moveTo(cx - baseW / 2, poleBot);
  ctx.lineTo(cx + baseW / 2, poleBot);
  ctx.stroke();

  const buffer = canvas.toBuffer('image/png');
  const outPath = join(ICONS_DIR, `icon-${size}.png`);
  writeFileSync(outPath, buffer);
  console.log(`✓ Generated ${outPath} (${size}×${size})`);
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

console.log('\n✅ All icons generated in src/icons/');

