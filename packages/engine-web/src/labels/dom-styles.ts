/**
 * DOM map labels for the `app`, `minimal`, `clean` and `sticker` styles
 * (prototype `buildMapLabels` / `updateMapLabels`) and the engine's label /
 * holo / name-tag / map-UI stylesheet (ported from `preview.css` classes
 * `.ml*`, `.ls-*`, `.hl*`, `.hi-*`, `.tag`, `.scalebar`, `.zoombtns`,
 * `.attrib`, prefixed with `mpr-`).
 *
 * @module
 */

import type { LabelContent, LabelContentMode, LabelsSpec } from '@maprama/protocol';
import type { CameraController } from '../core/camera.js';
import { ICON_COLORS, POI_GLYPHS } from './icons.js';
import { clampLabelX, domLabelVisible, resolveLabelContent, rotatedBox, uprightAngle, overlaps, type Box, type DomLabelStyle, type LabelEntry } from './index.js';

const STYLE_ID = 'maprama-engine-labels-style';
const FONT = `'IBM Plex Sans KR','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',system-ui,sans-serif`;
const DISPLAY = `'Jua','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif`;

const CSS = `
.mpr-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:${FONT}}
.mpr-ml{position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;will-change:transform;color:#2F3440;text-shadow:0 0 2px #fff,0 0 4px #fff,0 0 7px rgba(255,255,255,.9)}
.mpr-ml-district{font-size:15px;font-weight:600;letter-spacing:.28em;color:#474C58}
.mpr-ml-water{font-size:13px;font-weight:500;letter-spacing:.32em;color:#2F6F9E;font-style:italic}
.mpr-ml-road{font-size:11px;font-weight:500;color:#565C67}
.mpr-ml-road.art{font-weight:600;color:#6A4712}
.mpr-ml-poi{display:flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600}
.mpr-ml-poi i{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;font:700 10px ${FONT};color:#fff;box-shadow:0 0 0 1.5px #fff;text-shadow:none;font-style:normal}
.mpr-ml-poi i svg{width:12px;height:12px}
.mpr-labels.night .mpr-ml{color:#E8ECF5;text-shadow:0 0 3px #0B1020,0 0 7px rgba(8,12,30,.95)}
.mpr-labels.night .mpr-ml-district{color:#C9D2E6}
.mpr-labels.night .mpr-ml-road.art{color:#F3D08A}
.mpr-labels.ls-minimal .mpr-ml{color:#3A404B;text-shadow:0 0 3px rgba(255,255,255,.98),0 0 1px #fff,0 0 6px rgba(255,255,255,.8)}
.mpr-labels.ls-minimal .mpr-ml-district{font-size:12.5px;font-weight:600;letter-spacing:.5em;color:#454B57}
.mpr-labels.ls-minimal .mpr-ml-water{font-size:12px;letter-spacing:.4em}
.mpr-labels.ls-minimal .mpr-ml-road{font-size:10.5px;font-weight:500;color:#4A505B}
.mpr-labels.ls-minimal .mpr-ml-road.art{font-weight:600;color:#6E4F1A}
.mpr-labels.ls-minimal .mpr-ml-poi{font-size:10.5px;font-weight:500;gap:3px}
.mpr-labels.ls-minimal .mpr-ml-poi i{width:12px;height:12px;box-shadow:0 0 0 1px #fff}
.mpr-labels.ls-minimal .mpr-ml-poi i svg{width:8px;height:8px}
.mpr-labels.ls-sticker .mpr-ml{font-family:${DISPLAY};letter-spacing:0;text-shadow:none;color:#2A2540;background:#fff;border:1.5px solid #2A2540;border-radius:999px;padding:3px 9px 2px;box-shadow:0 2px 0 #2A2540}
.mpr-labels.ls-sticker .mpr-ml-district{background:#2A2540;color:#fff;font-size:14px;padding:4px 12px 3px}
.mpr-labels.ls-sticker .mpr-ml-water{background:#DDEFFB;color:#1F5E8C;font-style:normal}
.mpr-labels.ls-sticker .mpr-ml-road{font-size:11.5px;font-weight:400}
.mpr-labels.ls-sticker .mpr-ml-road.art{background:#FFE7A8;color:#2A2540}
.mpr-labels.ls-sticker .mpr-ml-poi{padding:2px 9px 2px 2px;font-weight:400}
.mpr-labels.ls-clean .mpr-ml{color:#2B313C;text-shadow:0 0 1px #fff,0 0 2px #fff,0 0 3px #fff,0 1px 7px rgba(255,255,255,.9);transition:opacity .25s}
.mpr-labels.ls-clean .mpr-ml-district{font-size:13px;font-weight:700;letter-spacing:.42em;color:#343A46}
.mpr-labels.ls-clean .mpr-ml-water{font-size:12px;font-weight:600;letter-spacing:.42em;color:#2A6C9C;font-style:normal}
.mpr-labels.ls-clean .mpr-ml-road{font-size:12px;font-weight:700;color:#2F3540;letter-spacing:.02em}
.mpr-labels.ls-clean .mpr-ml-road.art{color:#252B35;text-shadow:none;background:rgba(255,255,255,.8);border:1px solid rgba(255,255,255,.95);box-shadow:0 2px 10px -3px rgba(40,50,70,.35);padding:2px 8px;border-radius:6px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.mpr-labels.ls-clean .mpr-ml-poi{font-size:11px;font-weight:600;gap:5px}
.mpr-labels.ls-clean .mpr-ml-poi i{width:15px;height:15px;box-shadow:0 0 0 1.5px #fff,0 1px 4px rgba(0,0,0,.25)}
.mpr-labels.ls-clean .mpr-ml-poi i svg{width:9px;height:9px}
.mpr-labels.night.ls-clean .mpr-ml{color:#EEF2F8;text-shadow:0 0 2px #0B1020,0 0 7px rgba(8,12,30,.95)}
.mpr-labels.night.ls-clean .mpr-ml-road.art{background:rgba(20,26,40,.72);border-color:rgba(255,255,255,.18);color:#F3F5FA}
.mpr-ml small{display:block;font-size:.72em;font-weight:500;letter-spacing:.02em;opacity:.8}
.mpr-hl{position:absolute;left:0;top:0;pointer-events:none}
.mpr-hl-dot,.mpr-hl-line,.mpr-hl-panel{position:absolute;left:0;top:0;will-change:transform}
.mpr-hl-dot{width:0;height:0}
.mpr-hl-dot::before{content:"";position:absolute;left:-4px;top:-4px;width:8px;height:8px;border-radius:50%;background:#6FB7FF;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 0 12px 2px rgba(111,183,255,.85);transform:scale(0);transition:transform .18s ease-out}
.mpr-hl-dot::after{content:"";position:absolute;left:-12px;top:-12px;width:24px;height:24px;border-radius:50%;border:1.5px solid rgba(111,183,255,.75);opacity:0}
.mpr-hl.on .mpr-hl-dot::before{transform:scale(1)}
.mpr-hl.on .mpr-hl-dot::after{animation:mpr-hlring 1.8s ease-out .1s infinite}
@keyframes mpr-hlring{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.5);opacity:0}}
.mpr-hl-line{height:0;transform-origin:0 0}
.mpr-hl-line::after{content:"";position:absolute;left:0;top:-.75px;width:100%;height:1.5px;background:linear-gradient(90deg,rgba(111,183,255,.25),rgba(111,183,255,.95));box-shadow:0 0 6px rgba(111,183,255,.75);transform:scaleX(0);transform-origin:0 50%;transition:transform .22s cubic-bezier(.2,.8,.2,1) .06s}
.mpr-hl.on .mpr-hl-line::after{transform:scaleX(1)}
.mpr-hl-card{position:relative;display:flex;align-items:center;gap:7px;padding:5px 11px 5px 5px;border-radius:11px;white-space:nowrap;background:linear-gradient(135deg,rgba(255,255,255,.84),rgba(230,241,255,.62));border:1px solid rgba(255,255,255,.95);box-shadow:0 12px 26px -12px rgba(30,60,120,.5),inset 0 0 0 1px rgba(111,183,255,.3);-webkit-backdrop-filter:blur(10px) saturate(1.3);backdrop-filter:blur(10px) saturate(1.3);transform:translateY(8px) scale(.72);transform-origin:50% 100%;opacity:0;filter:blur(4px);transition:transform .28s cubic-bezier(.2,.9,.25,1.25) .2s,opacity .2s ease .2s,filter .22s ease .2s}
.mpr-hl.on .mpr-hl-card{transform:none;opacity:1;filter:none}
.mpr-hl-card::before{content:"";position:absolute;left:8px;right:8px;top:-1px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,#6FB7FF,transparent)}
.mpr-hl-ico{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--c,#3E7BFA);color:#fff;font:700 10px ${FONT};box-shadow:0 0 12px -2px var(--c,#3E7BFA)}
.mpr-hl-ico svg{width:15px;height:15px}
.mpr-hl-txt{display:grid;line-height:1.18}
.mpr-hl-txt b{font-size:12px;font-weight:600;color:#1E2533}
.mpr-hl-txt small{font-size:8.5px;font-weight:600;letter-spacing:.08em;color:#5C6B80}
.mpr-hl-district .mpr-hl-card{padding:7px 14px 7px 7px}
.mpr-hl-district .mpr-hl-txt b{font-size:14px;letter-spacing:.14em}
.mpr-labels.night .mpr-hl-card{background:linear-gradient(135deg,rgba(18,26,46,.8),rgba(26,42,78,.62));border-color:rgba(140,190,255,.45);box-shadow:0 12px 26px -12px rgba(0,0,0,.7),inset 0 0 0 1px rgba(111,183,255,.35),0 0 18px -6px rgba(111,183,255,.6)}
.mpr-labels.night .mpr-hl-txt b{color:#EAF2FF}
.mpr-labels.night .mpr-hl-txt small{color:#9FB6D6}
.mpr-labels.hi-white .mpr-hl-ico{background:linear-gradient(150deg,#FFFFFF,#EBF1F8);color:#1C2330;box-shadow:0 0 0 1px rgba(20,30,50,.09),0 3px 8px -3px rgba(20,40,80,.35),inset 0 1px 0 #fff}
.mpr-labels.hi-black .mpr-hl-ico{background:linear-gradient(150deg,#2B313D,#10131A);color:#F4F7FB;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 3px 10px -3px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.14)}
.mpr-labels.hi-color .mpr-hl-ico svg{--c:rgba(255,255,255,.95)}
.mpr-hl-card.mpr-hl-textonly{padding:6px 12px}
.mpr-hl-card.mpr-hl-custom .mpr-hl-txt small{font-size:10px;letter-spacing:.01em;font-weight:600;color:#2F6BFF}
.mpr-labels.night .mpr-hl-card.mpr-hl-custom .mpr-hl-txt small{color:#8FC3FF}
.mpr-tag{position:absolute;left:0;top:0;font-family:${DISPLAY};font-size:12px;line-height:1;padding:4px 7px 3px;border-radius:8px;background:#fff;color:#2A2540;border:1.5px solid #2A2540;white-space:nowrap;will-change:transform;pointer-events:none}
.mpr-tag.me{background:var(--tag,#2F5BEA);color:#fff}
.mpr-plus{position:absolute;left:0;top:0;font-family:${DISPLAY};font-size:20px;color:#FFC93C;-webkit-text-stroke:1.5px #2A2540;animation:mpr-rise .9s ease-out forwards;pointer-events:none}
@keyframes mpr-rise{from{opacity:1;margin-top:0}to{opacity:0;margin-top:-46px}}
.mpr-ui{position:absolute;inset:0;pointer-events:none;font-family:${FONT}}
.mpr-zoombtns{position:absolute;right:14px;top:calc(env(safe-area-inset-top,0px) + 56px);display:grid;gap:8px}
.mpr-zb{pointer-events:auto;width:44px;height:44px;display:grid;place-items:center;padding:0;cursor:pointer;font:400 22px/1 ${DISPLAY};background:#fff;border:2px solid #2A2540;border-radius:999px;box-shadow:0 3px 0 #2A2540;color:#2A2540;-webkit-tap-highlight-color:transparent}
.mpr-zb:active{transform:translateY(2px);box-shadow:0 1px 0 #2A2540}
.mpr-zb:focus-visible{outline:2px solid #2F5BEA;outline-offset:2px}
.mpr-scalebar{position:absolute;left:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);display:grid;gap:2px;font:600 11px ${FONT};color:#2A2540;text-shadow:0 0 3px #fff,0 0 3px #fff}
.mpr-scalebar i{display:block;height:6px;border:2px solid #2A2540;border-top:0;box-shadow:0 1px 0 #fff}
.mpr-attrib{position:absolute;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);max-width:60%;text-align:right;font:10px ${FONT};color:rgba(42,37,64,.8);text-shadow:0 0 3px #fff,0 0 3px #fff}
.mpr-ui.night .mpr-scalebar{color:#EEF2F8;text-shadow:0 0 3px #0B1020}
.mpr-ui.night .mpr-scalebar i{border-color:#EEF2F8;box-shadow:0 1px 0 #0B1020}
.mpr-ui.night .mpr-attrib{color:rgba(238,242,248,.8);text-shadow:0 0 3px #0B1020}
@media (prefers-reduced-motion: reduce){.mpr-hl-card,.mpr-hl-line::after,.mpr-hl-dot::before{transition:none}.mpr-hl.on .mpr-hl-dot::after{animation:none}.mpr-plus{animation-duration:.01s}}
.mpr-reduce-motion .mpr-hl-card,.mpr-reduce-motion .mpr-hl-line::after,.mpr-reduce-motion .mpr-hl-dot::before{transition:none}
.mpr-reduce-motion .mpr-hl.on .mpr-hl-dot::after{animation:none}
`;

/** Injects the label / UI stylesheet once per document. */
export function ensureLabelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** Minimum gap (ms) between two DOM label placements (≈ every other frame at 60 fps). */
const MIN_INTERVAL_MS = 24;

interface DomLabel {
  entry: LabelEntry;
  el: HTMLDivElement;
  w: number;
  h: number;
  shown: boolean;
  key: string;
}

/** The DOM label layer for the map-app styles. */
export class DomLabels {
  private labels: DomLabel[] = [];
  private lastUpdate = -Infinity;

  constructor(private readonly layer: HTMLElement) {}

  build(entries: readonly LabelEntry[]): void {
    this.clear();
    const doc = this.layer.ownerDocument;
    for (const e of [...entries].sort((a, b) => a.pri - b.pri)) {
      const el = doc.createElement('div');
      el.className = 'mpr-ml ' + (e.kind === 'district' ? (e.water ? 'mpr-ml-water' : 'mpr-ml-district') : e.kind === 'road' ? 'mpr-ml-road' + (e.roadClass === 'arterial' ? ' art' : '') : 'mpr-ml-poi');
      el.dataset.labelId = e.id;
      el.style.display = 'none';
      this.layer.appendChild(el);
      this.labels.push({ entry: e, el, w: 0, h: 0, shown: false, key: '' });
    }
  }

  /** Forces re-measuring (style or content change). */
  invalidate(): void {
    for (const l of this.labels) { l.w = 0; l.key = ''; }
  }

  hide(): void {
    for (const l of this.labels) if (l.shown) { l.el.style.display = 'none'; l.shown = false; }
  }

  /**
   * Places the labels. `now` is the frame timestamp (ms): placement is
   * throttled to {@link MIN_INTERVAL_MS}, which skips every other frame at
   * 60 fps like before but — unlike a frame counter — never skips an isolated
   * on-demand frame (after a resize, say), which would leave labels stale.
   */
  update(cam: CameraController, style: DomLabelStyle, spec: LabelsSpec, entries: Readonly<Record<string, LabelContent>>, zoomOut: number, exclusions: readonly Box[], now: number): void {
    if (now - this.lastUpdate < MIN_INTERVAL_MS) return;
    this.lastUpdate = now;
    const mode: LabelContentMode = spec.content ?? 'nameAndType';
    const dist = cam.orbit.distance, W = cam.width, H = cam.height;
    const placed: Box[] = [...exclusions];
    for (const l of this.labels) {
      const e = l.entry;
      let show = domLabelVisible(style, e, dist, zoomOut);
      let sx = 0, sy = 0;
      if (show) {
        const s = cam.worldToScreen(e.x, 0.3, e.z);
        if (!(s.x >= -0.025 * W && s.x <= 1.025 * W && s.y >= -0.025 * H && s.y <= 1.025 * H) || !inFront(cam, e.x, e.z)) show = false;
        sx = s.x;
        sy = s.y;
      }
      if (!show) { if (l.shown) { l.el.style.display = 'none'; l.shown = false; } continue; }
      this.applyContent(l, mode, entries);
      let ang = 0;
      if (e.kind === 'road' && style !== 'sticker' && e.tx !== undefined && e.tz !== undefined) {
        const s2 = cam.worldToScreen(e.x + e.tx * 3, 0.3, e.z + e.tz * 3);
        ang = uprightAngle(Math.atan2(s2.y - sy, s2.x - sx));
      }
      l.el.style.display = '';
      if (!l.w) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
      // keep the whole (rotated) label inside the viewport horizontally instead of clipping it at the edge
      sx = clampLabelX(sx, (Math.abs(Math.cos(ang)) * l.w + Math.abs(Math.sin(ang)) * l.h) / 2, W);
      const box = rotatedBox(sx, sy, l.w, l.h, ang);
      if (placed.some((p) => overlaps(p, box))) { l.el.style.display = 'none'; l.shown = false; continue; }
      placed.push(box);
      l.shown = true;
      l.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) rotate(${ang.toFixed(3)}rad)`;
      l.el.style.opacity = e.kind === 'district' ? String(Math.min(1, 0.45 + zoomOut)) : '1';
    }
  }

  private applyContent(l: DomLabel, mode: LabelContentMode, entries: Readonly<Record<string, LabelContent>>): void {
    const c = resolveLabelContent(l.entry, mode, entries);
    const key = `${mode}|${c.title}|${c.subtitle}|${c.icon}|${c.showIcon}|${c.showSubtitle}`;
    if (key === l.key) return;
    l.key = key;
    l.w = 0;
    const doc = l.el.ownerDocument;
    l.el.textContent = '';
    if (l.entry.kind === 'poi' && c.showIcon) {
      const i = doc.createElement('i');
      i.style.background = ICON_COLORS[c.icon];
      const cat = l.entry.category;
      i.innerHTML = cat && c.icon === cat ? POI_GLYPHS[cat] : (POI_GLYPHS as Record<string, string>)[c.icon] ?? '';
      l.el.appendChild(i);
    }
    const span = doc.createElement('span');
    span.textContent = c.title;
    if (c.showSubtitle && c.subtitle && l.entry.kind === 'poi') {
      const sm = doc.createElement('small');
      sm.textContent = c.subtitle;
      span.appendChild(sm);
    }
    l.el.appendChild(span);
  }

  clear(): void {
    for (const l of this.labels) l.el.remove();
    this.labels = [];
  }
}

/** True when the ground point is in front of the camera. */
export function inFront(cam: CameraController, x: number, z: number): boolean {
  const c = cam.camera;
  const dx = x - c.position.x, dy = -c.position.y, dz = z - c.position.z;
  const e = c.matrixWorld.elements;
  // camera looks down its local −Z axis
  return -(dx * e[8]! + dy * e[9]! + dz * e[10]!) > 0;
}
