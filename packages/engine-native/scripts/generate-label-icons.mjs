#!/usr/bin/env node
/**
 * Generates `cpp/src/LabelIcons.cpp`: engine-web's label icon set and label texts for the native label views
 * (DESIGN.md §6.5), so both platforms draw the same line icons as engine-web from one table in the core.
 *
 * - `HOLO_ICONS` (20×20 line icons, accent `var(--c)`) and `POI_GLYPHS` (16×16 white badge glyphs; `subway`
 *   is the text "M") are converted from SVG into vector shapes: every path / rect / circle becomes absolute
 *   move / line / cubic / close commands (arcs and quadratics are converted to cubics here), with its fill
 *   and stroke roles (`currentColor`, the accent colour, white) resolved from the SVG attributes and styles.
 *   The platforms replay them into a `CGPath` / `android.graphics.Path` (vector, crisp at every scale,
 *   tinted per icon tile), so no PNGs are generated.
 * - `ICON_COLORS`, `POI_SUBTITLES` and `KIND_SUBTITLES` become lookup tables for `LabelSystem`.
 *
 * engine-web stays the single source of truth: `npm test` runs this script with `--check`, which fails when
 * the committed file differs from engine-web's `src/labels/icons.ts`.
 *
 *   node scripts/generate-label-icons.mjs          # (re)write cpp/src/LabelIcons.cpp
 *   node scripts/generate-label-icons.mjs --check  # exit 1 when it is out of date
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '@maprama/protocol';
import { loadWebLabels } from './web-labels.mjs';

const outPath = fileURLToPath(new URL('../cpp/src/LabelIcons.cpp', import.meta.url));
const check = process.argv.includes('--check');
const L = await loadWebLabels();

// ---------------------------------------------------------------------------
// SVG -> shapes
// ---------------------------------------------------------------------------

const KAPPA = 0.5522847498307936;
const round = (n) => Math.round(n * 1e4) / 1e4;

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  if (out.style) {
    for (const decl of out.style.split(';')) {
      const [k, v] = decl.split(':').map((s) => s?.trim());
      if (k && v !== undefined) out[k] = v;
    }
    delete out.style;
  }
  return out;
}

/** Arc (SVG endpoint parameterisation, spec F.6.5) as cubic segments `[c1x, c1y, c2x, c2y, x, y]`. */
function arcToCubics(x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * yp) / ry, cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const d = dt / n, k = (4 / 3) * Math.tan(d / 4);
  const map = (ux, uy) => [cx + rx * ux * cos - ry * uy * sin, cy + rx * ux * sin + ry * uy * cos];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a0 = t1 + i * d, a1 = a0 + d;
    const c1 = map(Math.cos(a0) - k * Math.sin(a0), Math.sin(a0) + k * Math.cos(a0));
    const c2 = map(Math.cos(a1) + k * Math.sin(a1), Math.sin(a1) - k * Math.cos(a1));
    const p = i === n - 1 ? [x2, y2] : map(Math.cos(a1), Math.sin(a1));
    out.push([...c1, ...c2, ...p]);
  }
  return out;
}

/** SVG path data -> `{ops: 'MLCZ…', coords: [...]}` in absolute coordinates. */
function parsePath(d) {
  let i = 0;
  const ops = [];
  const coords = [];
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const num = () => {
    skip();
    const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(d.slice(i));
    if (!m) throw new Error(`generate-label-icons: bad number at ${i} in "${d}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i++];
    if (c !== '0' && c !== '1') throw new Error(`generate-label-icons: bad arc flag in "${d}"`);
    return c === '1';
  };
  const more = () => {
    skip();
    return i < d.length && /[+\-.\d]/.test(d[i]);
  };
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCubic = null, lastQuad = null;
  const moveTo = (nx, ny) => {
    ops.push('M');
    coords.push(nx, ny);
    x = sx = nx;
    y = sy = ny;
  };
  const lineTo = (nx, ny) => {
    ops.push('L');
    coords.push(nx, ny);
    x = nx;
    y = ny;
  };
  const cubicTo = (c) => {
    ops.push('C');
    coords.push(...c);
    x = c[4];
    y = c[5];
  };
  let cmd = null;
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) throw new Error(`generate-label-icons: path must start with a command: "${d}"`);
    const rel = cmd === cmd.toLowerCase();
    const ox = () => (rel ? x : 0), oy = () => (rel ? y : 0);
    let first = true;
    do {
      const C = cmd.toUpperCase();
      let cubic = null, quad = null;
      if (C === 'Z') {
        ops.push('Z');
        x = sx;
        y = sy;
      } else if (C === 'M') {
        const nx = num() + ox(), ny = num() + oy();
        if (first) moveTo(nx, ny);
        else lineTo(nx, ny);
      } else if (C === 'L') {
        const nx = num() + ox(), ny = num() + oy();
        lineTo(nx, ny);
      } else if (C === 'H') {
        lineTo(num() + ox(), y);
      } else if (C === 'V') {
        lineTo(x, num() + oy());
      } else if (C === 'C') {
        const b = [ox(), oy()];
        cubic = [num() + b[0], num() + b[1], num() + b[0], num() + b[1], num() + b[0], num() + b[1]];
        cubicTo(cubic);
      } else if (C === 'S') {
        const b = [ox(), oy()];
        const c1 = lastCubic ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]] : [x, y];
        cubic = [...c1, num() + b[0], num() + b[1], num() + b[0], num() + b[1]];
        cubicTo(cubic);
      } else if (C === 'Q' || C === 'T') {
        const b = [ox(), oy()];
        const q = C === 'Q' ? [num() + b[0], num() + b[1]] : lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y];
        const nx = num() + b[0], ny = num() + b[1];
        quad = q;
        cubicTo([x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), nx + (2 / 3) * (q[0] - nx), ny + (2 / 3) * (q[1] - ny), nx, ny]);
      } else if (C === 'A') {
        const rx = num(), ry = num(), phi = num(), large = flag(), sweep = flag();
        const nx = num() + ox(), ny = num() + oy();
        for (const seg of arcToCubics(x, y, rx, ry, phi, large, sweep, nx, ny)) cubicTo(seg);
      } else {
        throw new Error(`generate-label-icons: unsupported path command ${cmd} in "${d}"`);
      }
      // the control point a following S / T reflects, as an absolute position
      lastCubic = cubic ? [cubic[2], cubic[3]] : null;
      lastQuad = quad;
      first = false;
      if (C === 'Z') break;
    } while (more());
  }
  return { ops: ops.join(''), coords };
}

function rectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return { ops: 'MLLLZ', coords: [x, y, x + w, y, x + w, y + h, x, y + h] };
  const k = r * KAPPA;
  const c = [];
  c.push(x + r, y);
  c.push(x + w - r, y);
  c.push(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
  c.push(x + w, y + h - r);
  c.push(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
  c.push(x + r, y + h);
  c.push(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
  c.push(x, y + r);
  c.push(x, y + r - k, x + r - k, y, x + r, y);
  return { ops: 'MLCLCLCLCZ', coords: c };
}

function circlePath(cx, cy, r) {
  const k = r * KAPPA;
  return {
    ops: 'MCCCCZ',
    coords: [
      cx + r, cy,
      cx + r, cy + k, cx + k, cy + r, cx, cy + r,
      cx - k, cy + r, cx - r, cy + k, cx - r, cy,
      cx - r, cy - k, cx - k, cy - r, cx, cy - r,
      cx + k, cy - r, cx + r, cy - k, cx + r, cy,
    ],
  };
}

const PAINTS = { none: 'IconPaint::None', currentColor: 'IconPaint::Current', 'var(--c)': 'IconPaint::Accent', '#fff': 'IconPaint::White' };
function paint(value, what) {
  const p = PAINTS[value ?? 'none'];
  if (!p) throw new Error(`generate-label-icons: unsupported ${what} "${value}"`);
  return p;
}

/** One SVG string -> `{viewBox, roundCaps, shapes}` (or `{text}` for a plain-text glyph such as "M"). */
function convertSvg(svg) {
  if (!svg.startsWith('<svg')) return { text: svg, viewBox: 16, roundCaps: false, shapes: [] };
  const root = attrs(/^<svg\b([^>]*)>/.exec(svg)[1]);
  const vb = root.viewBox.split(/\s+/).map(Number);
  if (vb[0] !== 0 || vb[1] !== 0 || vb[2] !== vb[3]) throw new Error(`generate-label-icons: unexpected viewBox ${root.viewBox}`);
  const shapes = [];
  for (const m of svg.matchAll(/<(path|rect|circle)\b([^>]*?)\/?>/g)) {
    const a = { ...root, ...attrs(m[2]) };
    let geo;
    if (m[1] === 'path') geo = parsePath(a.d);
    else if (m[1] === 'rect') geo = rectPath(+a.x || 0, +a.y || 0, +a.width, +a.height, +(a.rx ?? a.ry ?? 0));
    else geo = circlePath(+a.cx, +a.cy, +a.r);
    shapes.push({
      fill: paint(a.fill, 'fill'),
      fillOpacity: a['fill-opacity'] !== undefined ? +a['fill-opacity'] : 1,
      stroke: paint(a.stroke, 'stroke'),
      strokeWidth: a['stroke-width'] !== undefined ? +a['stroke-width'] : 1,
      ...geo,
    });
  }
  return { viewBox: vb[2], roundCaps: root['stroke-linecap'] === 'round', shapes, text: null };
}

// ---------------------------------------------------------------------------
// C++ output
// ---------------------------------------------------------------------------

const cppString = (s) => JSON.stringify(s); // UTF-8 source; JSON escapes are valid C++ escapes for this text
/** A C++ float literal (`8.0f`, `1.6f`). */
const flt = (n) => {
  const r = round(n) || 0; // no "-0"
  return Number.isInteger(r) ? `${r}.0f` : `${r}f`;
};
const floats = (xs) => xs.map(flt).join(', ');
const ICON_ENUM = (icon) => `LabelIcon::${icon[0].toUpperCase()}${icon.slice(1)}`;

function drawingCode(prefix, drawing) {
  const lines = [];
  drawing.shapes.forEach((s, i) => lines.push(`const float ${prefix}_c${i}[] = {${floats(s.coords)}};`));
  const shapes = drawing.shapes.map(
    (s, i) => `    {${s.fill}, ${flt(s.fillOpacity)}, ${s.stroke}, ${flt(s.strokeWidth)}, ${cppString(s.ops)}, ${prefix}_c${i}, ${s.coords.length}},`,
  );
  if (shapes.length) lines.push(`const IconShape ${prefix}_shapes[] = {\n${shapes.join('\n')}\n};`);
  const shapesRef = shapes.length ? `${prefix}_shapes` : 'nullptr';
  const text = drawing.text ? cppString(drawing.text) : 'nullptr';
  lines.push(
    `const IconDrawing ${prefix} = {${drawing.viewBox}.0f, ${drawing.roundCaps}, ${shapesRef}, ${drawing.shapes.length}, ${text}};`,
  );
  return lines.join('\n');
}

const hex = (css) => `0x${css.slice(1).toUpperCase()}`;
const blocks = [];
for (const icon of P.LABEL_ICONS) blocks.push(drawingCode(`holo_${icon}`, convertSvg(L.HOLO_ICONS[icon])));
for (const cat of P.POI_CATEGORIES) blocks.push(drawingCode(`poi_${cat}`, convertSvg(L.POI_GLYPHS[cat])));

const text = `// GENERATED by scripts/generate-label-icons.mjs from engine-web src/labels/icons.ts — do not edit.
// Label icons (HOLO_ICONS, POI_GLYPHS) as vector shapes, icon colours and default label subtitles.
#include "maprama/LabelIcons.hpp"

namespace maprama {

namespace {

${blocks.join('\n\n')}

}  // namespace

const IconDrawing& holoIcon(LabelIcon icon) {
  switch (icon) {
${P.LABEL_ICONS.map((i) => `    case ${ICON_ENUM(i)}:\n      return holo_${i};`).join('\n')}
  }
  return holo_${P.LABEL_ICONS[0]};
}

const IconDrawing* poiGlyph(LabelIcon icon) {
  switch (icon) {
${P.POI_CATEGORIES.map((c) => `    case ${ICON_ENUM(c)}:\n      return &poi_${c};`).join('\n')}
    default:
      return nullptr;
  }
}

std::uint32_t iconColor(LabelIcon icon) {
  switch (icon) {
${P.LABEL_ICONS.map((i) => `    case ${ICON_ENUM(i)}:\n      return ${hex(L.ICON_COLORS[i])};`).join('\n')}
  }
  return 0;
}

std::string_view poiSubtitle(PoiCategory category) {
  switch (category) {
${P.POI_CATEGORIES.map((c) => `    case PoiCategory::${c[0].toUpperCase()}${c.slice(1)}:\n      return ${cppString(L.POI_SUBTITLES[c])};`).join('\n')}
  }
  return {};
}

std::string_view kindSubtitle(LabelIcon icon) {
  switch (icon) {
${Object.entries(L.KIND_SUBTITLES).map(([k, v]) => `    case ${ICON_ENUM(k)}:\n      return ${cppString(v)};`).join('\n')}
    default:
      return {};
  }
}

}  // namespace maprama
`;

if (check) {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    // missing file: reported below
  }
  if (current !== text) {
    console.error('generate-label-icons: cpp/src/LabelIcons.cpp is out of date; run `node scripts/generate-label-icons.mjs`');
    process.exit(1);
  }
  console.log('generate-label-icons: cpp/src/LabelIcons.cpp matches engine-web src/labels/icons.ts');
} else {
  writeFileSync(outPath, text);
  console.log(`generate-label-icons: wrote ${outPath}`);
}
