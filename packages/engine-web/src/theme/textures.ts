/**
 * Procedural canvas textures (ported from the prototype): facade sets
 * (realistic, toy, modern, urban, soft), storefront bands, ground / asphalt /
 * sidewalk / stone / gravel / roof tiles, contact-shadow AO and glow.
 *
 * Color maps and emissive maps are tagged `SRGBColorSpace` (three r186 color
 * management); alpha masks (AO, glow, beam) stay `NoColorSpace`.
 *
 * @module
 */

import { CanvasTexture, ClampToEdgeWrapping, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { clampi, mulberry32 } from '../util/math.js';

type Ctx = CanvasRenderingContext2D;
type Rng = () => number;
type RGB = [number, number, number];

/** A facade texture pair with its tile size in world units. */
export interface FacadeTexture {
  tex: Texture;
  /** Lit-window emissive map. */
  lit: Texture;
  /** Tile width (world units). */
  U: number;
  /** Tile height (world units). */
  V: number;
}

/** Facade keys: realistic `glass|office|apartment|brick`, `toy`, modern `m_*`, urban `u_*`, `soft`. */
export type FacadeKey =
  | 'glass' | 'office' | 'apartment' | 'brick' | 'toy'
  | 'm_glass' | 'm_band' | 'm_resi' | 'm_terracotta'
  | 'u_glass' | 'u_panel' | 'u_grid' | 'u_concrete'
  | 'soft';

export interface TextureSet {
  facade: Record<FacadeKey, FacadeTexture>;
  /** Source canvases of the facade textures (for UI thumbnails). */
  facadeCanvases: Partial<Record<FacadeKey, HTMLCanvasElement>>;
  grass: Texture;
  grassPad: Texture;
  asphaltV: Texture;
  asphaltH: Texture;
  sidewalk: Texture;
  stone: Texture;
  gravel: Texture;
  roofTiles: Texture;
  glassBand: Texture;
  glassBandM: Texture;
  glassBandU: Texture;
  store: Texture;
  storeLit: Texture;
  storeM: Texture;
  storeMLit: Texture;
  ao: Texture;
  glow: Texture;
  beam: Texture;
  sign: Texture;
  dispose(): void;
}

export interface TextureOptions {
  anisotropy?: number;
  /** Canvas factory (defaults to `document.createElement('canvas')`). */
  createCanvas?: (w: number, h: number) => HTMLCanvasElement;
}

export function roundRectPath(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Creates every procedural texture. Requires a DOM (canvas 2D). */
export function createTextures(opts: TextureOptions = {}): TextureSet {
  const aniso = opts.anisotropy ?? 4;
  const all: Texture[] = [];
  const mkCanvas = (w: number, h: number): [HTMLCanvasElement, Ctx] => {
    const c = opts.createCanvas ? opts.createCanvas(w, h) : document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d', { willReadFrequently: true }) as Ctx];
  };
  const toTex = (c: HTMLCanvasElement, rx?: number, ry?: number): Texture => {
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = aniso;
    t.colorSpace = SRGBColorSpace;
    if (rx) t.repeat.set(rx, ry ?? rx);
    all.push(t);
    return t;
  };
  const maskTex = (c: HTMLCanvasElement): Texture => {
    const t = new CanvasTexture(c);
    t.colorSpace = NoColorSpace;
    all.push(t);
    return t;
  };
  const grain = (g: Ctx, w: number, h: number, amt: number, seed: number): void => {
    const r = mulberry32(seed || 3), img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (r() - 0.5) * amt;
      d[i] = d[i]! + n; d[i + 1] = d[i + 1]! + n; d[i + 2] = d[i + 2]! + n;
    }
    g.putImageData(img, 0, 0);
  };
  const blotches = (g: Ctx, w: number, h: number, n: number, color: string, seed: number, rmax?: number): void => {
    const r = mulberry32(seed);
    g.fillStyle = color;
    for (let i = 0; i < n; i++) {
      g.globalAlpha = 0.04 + r() * 0.1;
      g.beginPath();
      g.arc(r() * w, r() * h, 3 + r() * (rmax || 22), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  };
  const grime = (g: Ctx, S: number, r: Rng, n: number, a: number): void => {
    for (let i = 0; i < n; i++) {
      const x = r() * S, y = r() * S, len = 12 + r() * 70, w = 1 + r() * 3;
      const gr = g.createLinearGradient(0, y, 0, y + len);
      gr.addColorStop(0, `rgba(38,34,28,${a})`);
      gr.addColorStop(1, 'rgba(38,34,28,0)');
      g.fillStyle = gr;
      g.fillRect(x, y, w, len);
    }
  };
  const shade = (r: Rng, base: RGB, spread: number): RGB => {
    const k = 1 + (r() - 0.5) * spread;
    return base.map((v) => clampi(v * k, 0, 255)) as RGB;
  };
  const rgba = (c: readonly number[], a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  interface PaneOpts { top?: RGB; bot?: RGB; curtains?: boolean; blinds?: boolean }
  const pane = (g: Ctx, x: number, y: number, w: number, h: number, r: Rng, o: PaneOpts = {}): void => {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    const t = shade(r, o.top || [150, 164, 174], 0.14), bt = shade(r, o.bot || [56, 66, 74], 0.18);
    const gr = g.createLinearGradient(x, y, x + w * 0.35, y + h);
    gr.addColorStop(0, rgba(t, 1));
    gr.addColorStop(1, rgba(bt, 1));
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
    if (r() < 0.6) { g.fillStyle = `rgba(28,24,20,${0.16 + r() * 0.3})`; g.fillRect(x, y + h * (0.35 + r() * 0.3), w, h); }
    if (o.curtains && r() < 0.5) {
      const cw = w * (0.2 + r() * 0.45);
      const c: RGB = r() < 0.5 ? [228, 220, 204] : [200, 192, 178];
      g.fillStyle = rgba(c, 0.9);
      if (r() < 0.5) g.fillRect(x, y, cw, h); else g.fillRect(x + w - cw, y, cw, h);
    }
    if (o.blinds && r() < 0.35) {
      const bh = h * (0.15 + r() * 0.6);
      g.fillStyle = 'rgba(208,206,199,.92)';
      g.fillRect(x, y, w, bh);
      g.fillStyle = 'rgba(0,0,0,.1)';
      for (let yy = y + 2; yy < y + bh; yy += 3) g.fillRect(x, yy, w, 1);
    }
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.beginPath();
    g.moveTo(x + w * 0.25, y); g.lineTo(x + w * 0.55, y); g.lineTo(x + w * 0.15, y + h); g.lineTo(x - w * 0.15, y + h);
    g.closePath();
    g.fill();
    g.restore();
  };
  const litPane = (lg: Ctx, x: number, y: number, w: number, h: number, r: Rng, p: number, cool: boolean): void => {
    if (r() >= p) return;
    const warm = !cool || r() < 0.3;
    const c = warm ? [255, 190 + ((r() * 45) | 0), 112 + ((r() * 55) | 0)] : [212, 226, 255];
    lg.fillStyle = rgba(c, 0.5 + r() * 0.5);
    lg.fillRect(x, y, w, h);
    if (r() < 0.4) { lg.fillStyle = 'rgba(0,0,0,.55)'; lg.fillRect(x + w * (0.3 + r() * 0.4), y, w * 0.14, h); }
  };
  type Painter = (g: Ctx, lg: Ctx, S: number, r: Rng, lr: Rng) => void;

  const REAL: Record<'glass' | 'office' | 'apartment' | 'brick', Painter> = {
    glass(g, lg, S, r, lr) {
      const gr = g.createLinearGradient(0, 0, S * 0.7, S);
      gr.addColorStop(0, '#9AA8B1'); gr.addColorStop(0.5, '#5B6973'); gr.addColorStop(1, '#84929B');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) for (let k = 0; k < 2; k++) {
        const x = cx * 128 + k * 64, y = cy * 128;
        g.fillStyle = r() < 0.5 ? `rgba(255,255,255,${r() * 0.08})` : `rgba(0,0,0,${r() * 0.12})`; g.fillRect(x, y, 64, 98);
        if (r() < 0.45) { g.fillStyle = `rgba(30,26,22,${0.1 + r() * 0.2})`; g.fillRect(x, y + 50, 64, 48); }
        if (r() < 0.25) { g.fillStyle = 'rgba(212,210,203,.5)'; g.fillRect(x, y, 64, 20 + r() * 50); }
        litPane(lg, x + 2, y + 2, 60, 94, lr, 0.32, true);
      }
      for (let y = 0; y < S; y += 128) { g.fillStyle = '#343B42'; g.fillRect(0, y + 98, S, 30); g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(0, y + 98, S, 2); }
      grain(g, S, S, 10, 61);
      g.fillStyle = '#22272C';
      for (let x = 0; x <= S; x += 64) g.fillRect(x - 1, 0, 3, S);
      for (let y = 0; y < S; y += 128) g.fillRect(0, y + 97, S, 2);
    },
    office(g, lg, S, r, lr) {
      g.fillStyle = '#BCB6AB'; g.fillRect(0, 0, S, S); grain(g, S, S, 20, 62);
      for (let y = 0; y < S; y += 128) { g.fillStyle = 'rgba(0,0,0,.05)'; g.fillRect(0, y, S, 2); }
      for (let x = 0; x < S; x += 128) { g.fillStyle = 'rgba(0,0,0,.04)'; g.fillRect(x, 0, 2, S); }
      grime(g, S, r, 40, 0.12);
      for (let y = 0; y < S; y += 128) {
        for (let x = 0; x < S; x += 32) { pane(g, x + 1, y + 40, 30, 50, r, { blinds: true, top: [158, 170, 178], bot: [60, 70, 78] }); litPane(lg, x + 1, y + 40, 30, 50, lr, 0.3, true); }
        g.fillStyle = '#2E3338'; for (let x = 0; x <= S; x += 32) g.fillRect(x - 1, y + 40, 2, 50);
        g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(0, y + 90, S, 5);
        g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(0, y + 38, S, 2);
      }
    },
    apartment(g, lg, S, r, lr) {
      g.fillStyle = '#DFD9CF'; g.fillRect(0, 0, S, S); grain(g, S, S, 14, 63);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
        const X = cx * 128, Y = cy * 128;
        g.fillStyle = '#EFEDE8'; g.fillRect(X + 8, Y + 20, 76, 70);
        pane(g, X + 11, Y + 23, 34, 64, r, { curtains: true }); pane(g, X + 47, Y + 23, 34, 64, r, { curtains: true });
        litPane(lg, X + 11, Y + 23, 70, 64, lr, 0.4, false);
        g.fillStyle = 'rgba(70,70,70,.5)'; g.fillRect(X + 8, Y + 70, 76, 2); g.fillRect(X + 8, Y + 80, 76, 2);
        g.fillStyle = '#EFEDE8'; g.fillRect(X + 94, Y + 28, 26, 52);
        pane(g, X + 97, Y + 31, 20, 46, r, { blinds: true });
        litPane(lg, X + 97, Y + 31, 20, 46, lr, 0.25, false);
        if (r() < 0.35) { g.fillStyle = '#C6C8C9'; g.fillRect(X + 90, Y + 92, 30, 18); g.fillStyle = 'rgba(0,0,0,.25)'; for (let i = 0; i < 5; i++) g.fillRect(X + 93 + i * 5, Y + 95, 2, 12); }
        g.fillStyle = '#C9C2B6'; g.fillRect(X, Y + 116, 128, 12); g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(X, Y + 113, 128, 3);
      }
      grime(g, S, r, 55, 0.1);
    },
    brick(g, lg, S, r, lr) {
      g.fillStyle = '#B2A291'; g.fillRect(0, 0, S, S);
      const pal: RGB[] = [[140, 80, 60], [152, 90, 68], [124, 70, 54], [162, 99, 76], [132, 86, 66]];
      for (let y = 0, row = 0; y < S; y += 10, row++) for (let x = row % 2 ? -12 : 0; x < S; x += 24) { const c = shade(r, pal[(r() * pal.length) | 0]!, 0.18); g.fillStyle = rgba(c, 1); g.fillRect(x + 1, y + 1, 22, 8); }
      grain(g, S, S, 18, 64);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
        const X = cx * 128 + 34, Y = cy * 128 + 26;
        g.fillStyle = '#CDC2B0'; g.fillRect(X - 6, Y - 10, 72, 9); g.fillRect(X - 4, Y + 72, 68, 7);
        g.fillStyle = '#2B2F33'; g.fillRect(X - 2, Y - 1, 64, 73);
        pane(g, X + 1, Y + 2, 28, 67, r, { curtains: true }); pane(g, X + 31, Y + 2, 28, 67, r, { curtains: true });
        litPane(lg, X + 1, Y + 2, 58, 67, lr, 0.42, false);
      }
      grime(g, S, r, 40, 0.14);
    },
  };

  const MODERN: Record<'glass' | 'band' | 'resi' | 'terracotta', Painter> = {
    glass(g, lg, S, r, lr) {
      const gr = g.createLinearGradient(0, 0, 0, S);
      gr.addColorStop(0, '#B3C4CF'); gr.addColorStop(0.55, '#728898'); gr.addColorStop(1, '#94A8B5');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) for (let k = 0; k < 2; k++) {
        const x = cx * 128 + k * 64, y = cy * 128;
        g.fillStyle = `rgba(255,255,255,${r() * 0.07})`; g.fillRect(x, y, 64, 104);
        if (r() < 0.3) { g.fillStyle = 'rgba(40,46,52,.18)'; g.fillRect(x, y + 60, 64, 44); }
        litPane(lg, x + 2, y + 2, 60, 100, lr, 0.34, true);
      }
      g.fillStyle = 'rgba(255,255,255,.1)'; g.beginPath(); g.moveTo(S * 0.1, 0); g.lineTo(S * 0.35, 0); g.lineTo(S * 0.05, S); g.lineTo(-S * 0.2, S); g.closePath(); g.fill();
      for (let y = 0; y < S; y += 128) { g.fillStyle = '#5A6873'; g.fillRect(0, y + 104, S, 24); g.fillStyle = '#E4EAEE'; g.fillRect(0, y + 103, S, 2); }
      g.fillStyle = '#E4EAEE'; for (let x = 0; x <= S; x += 64) g.fillRect(x - 1, 0, 2, S);
      grain(g, S, S, 4, 81);
    },
    band(g, lg, S, r, lr) {
      g.fillStyle = '#F1F0EC'; g.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 128) {
        const gr = g.createLinearGradient(0, y + 40, 0, y + 106); gr.addColorStop(0, '#8FA4B1'); gr.addColorStop(1, '#4F6371');
        g.fillStyle = gr; g.fillRect(0, y + 40, S, 66);
        for (let x = 0; x < S; x += 64) {
          g.fillStyle = `rgba(255,255,255,${r() * 0.08})`; g.fillRect(x, y + 40, 64, 66);
          if (r() < 0.25) { g.fillStyle = 'rgba(236,234,228,.8)'; g.fillRect(x, y + 40, 64, 12 + r() * 30); }
          litPane(lg, x + 1, y + 40, 62, 66, lr, 0.33, true);
        }
        g.fillStyle = '#D9DFE2'; for (let x = 0; x <= S; x += 64) g.fillRect(x - 1, y + 40, 2, 66);
        g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(0, y + 106, S, 4);
        g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(0, y + 38, S, 2);
      }
      grain(g, S, S, 4, 82);
    },
    resi(g, lg, S, r, lr) {
      g.fillStyle = '#EFEBE4'; g.fillRect(0, 0, S, S);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
        const X = cx * 128, Y = cy * 128;
        g.fillStyle = '#3A3F44'; g.fillRect(X + 8, Y + 12, 80, 84);
        const gr = g.createLinearGradient(X, Y + 14, X + 30, Y + 94); gr.addColorStop(0, '#A7BAC6'); gr.addColorStop(1, '#55697A');
        g.fillStyle = gr; g.fillRect(X + 11, Y + 15, 74, 78);
        if (r() < 0.55) { g.fillStyle = r() < 0.5 ? 'rgba(240,232,216,.9)' : 'rgba(214,204,188,.85)'; const cw = 14 + r() * 26; if (r() < 0.5) g.fillRect(X + 11, Y + 15, cw, 78); else g.fillRect(X + 85 - cw, Y + 15, cw, 78); }
        g.fillStyle = '#3A3F44'; g.fillRect(X + 47, Y + 15, 2, 78);
        litPane(lg, X + 11, Y + 15, 74, 78, lr, 0.45, false);
        g.fillStyle = 'rgba(215,232,238,.28)'; g.fillRect(X + 6, Y + 70, 86, 26); g.fillStyle = '#9DA6AB'; g.fillRect(X + 6, Y + 69, 86, 2);
        g.fillStyle = '#B98D66'; g.fillRect(X + 94, Y + 12, 28, 84);
        g.fillStyle = 'rgba(0,0,0,.14)'; for (let i = X + 97; i < X + 122; i += 5) g.fillRect(i, Y + 12, 1, 84);
        g.fillStyle = '#DCD6CD'; g.fillRect(X, Y + 116, 128, 12); g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(X, Y + 114, 128, 2);
      }
      grain(g, S, S, 4, 83);
    },
    terracotta(g, lg, S, r, lr) {
      g.fillStyle = '#C48B6B'; g.fillRect(0, 0, S, S);
      for (let x = 0; x < S; x += 16) { g.fillStyle = '#D4A080'; g.fillRect(x + 2, 0, 7, S); g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(x + 9, 0, 2, S); }
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
        const X = cx * 128 + 26, Y = cy * 128 + 18;
        g.fillStyle = '#26292C'; g.fillRect(X - 4, Y - 4, 84, 86);
        const gr = g.createLinearGradient(X, Y, X + 20, Y + 78); gr.addColorStop(0, '#A3B4BE'); gr.addColorStop(1, '#4E6070');
        g.fillStyle = gr; g.fillRect(X, Y, 76, 78);
        if (r() < 0.45) { g.fillStyle = 'rgba(236,226,208,.88)'; g.fillRect(X, Y, 76, 14 + r() * 34); }
        g.fillStyle = '#26292C'; g.fillRect(X + 37, Y, 2, 78);
        litPane(lg, X, Y, 76, 78, lr, 0.42, false);
      }
      for (let y = 0; y < S; y += 128) { g.fillStyle = '#B07A5C'; g.fillRect(0, y + 120, S, 8); }
      grain(g, S, S, 5, 84);
    },
  };

  const URBAN: Record<'glass' | 'panel' | 'grid' | 'concrete', Painter> = {
    glass(g, lg, S, r, lr) {
      const gr = g.createLinearGradient(0, 0, S * 0.3, S);
      gr.addColorStop(0, '#8FA3B5'); gr.addColorStop(0.45, '#3A4756'); gr.addColorStop(1, '#222B35');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 7; i++) { g.fillStyle = `rgba(10,14,20,${0.08 + r() * 0.12})`; const x = r() * S, w = 30 + r() * 90; g.fillRect(x, S * (0.3 + r() * 0.4), w, S); }
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) for (let k = 0; k < 2; k++) {
        const x = cx * 128 + k * 64, y = cy * 128;
        g.fillStyle = r() < 0.5 ? `rgba(255,255,255,${r() * 0.06})` : `rgba(0,0,0,${r() * 0.1})`; g.fillRect(x, y, 64, 110);
        if (r() < 0.25) { g.fillStyle = 'rgba(200,210,220,.14)'; g.fillRect(x + 4, y + 8, 56, 30 + r() * 50); }
        litPane(lg, x + 2, y + 2, 60, 106, lr, 0.38, true);
      }
      g.fillStyle = 'rgba(255,255,255,.09)'; g.beginPath(); g.moveTo(S * 0.45, 0); g.lineTo(S * 0.7, 0); g.lineTo(S * 0.35, S); g.lineTo(S * 0.1, S); g.closePath(); g.fill();
      for (let y = 0; y < S; y += 128) { g.fillStyle = '#1C232B'; g.fillRect(0, y + 110, S, 18); }
      g.fillStyle = '#9AA6B0';
      for (let x = 0; x <= S; x += 64) g.fillRect(x - 1, 0, 2, S);
      for (let y = 0; y < S; y += 128) { g.fillRect(0, y + 109, S, 2); g.fillRect(0, y + 127, S, 1); }
      grain(g, S, S, 3, 91);
    },
    panel(g, lg, S, r, lr) {
      g.fillStyle = '#A7AEB4'; g.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 64) for (let x = 0; x < S; x += 32) { g.fillStyle = r() < 0.5 ? `rgba(255,255,255,${r() * 0.06})` : `rgba(0,0,0,${r() * 0.05})`; g.fillRect(x, y, 32, 64); }
      g.fillStyle = 'rgba(0,0,0,.1)';
      for (let x = 0; x < S; x += 32) g.fillRect(x, 0, 1, S);
      for (let y = 0; y < S; y += 64) g.fillRect(0, y, S, 1);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) for (const ox of [8, 72]) {
        const X = cx * 128 + ox, Y = cy * 128 + 24;
        g.fillStyle = '#3A4046'; g.fillRect(X - 2, Y - 2, 48, 78);
        pane(g, X, Y, 44, 74, r, { blinds: true, top: [120, 138, 152], bot: [40, 50, 60] });
        litPane(lg, X, Y, 44, 74, lr, 0.34, true);
      }
      for (let x = 0; x < S; x += 64) { g.fillStyle = '#CDD2D6'; g.fillRect(x + 57, 0, 6, S); g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(x + 63, 0, 2, S); }
      grain(g, S, S, 5, 92);
    },
    grid(g, lg, S, r, lr) {
      g.fillStyle = '#D6D9DA'; g.fillRect(0, 0, S, S);
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
        const X = cx * 128, Y = cy * 128;
        g.fillStyle = '#4A535B'; g.fillRect(X + 12, Y + 14, 104, 92);
        const gr = g.createLinearGradient(X, Y + 20, X + 40, Y + 100); gr.addColorStop(0, '#8A9CAA'); gr.addColorStop(1, '#394753');
        g.fillStyle = gr; g.fillRect(X + 18, Y + 20, 92, 80);
        if (r() < 0.4) { g.fillStyle = r() < 0.5 ? 'rgba(226,222,212,.75)' : 'rgba(200,204,206,.7)'; g.fillRect(X + 18, Y + 20, 92, 10 + r() * 36); }
        g.fillStyle = '#2D343A'; g.fillRect(X + 63, Y + 20, 2, 80);
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(X + 18, Y + 20, 92, 6); g.fillRect(X + 18, Y + 20, 5, 80);
        g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(X + 12, Y + 106, 104, 2);
        litPane(lg, X + 18, Y + 20, 92, 80, lr, 0.4, false);
      }
      grain(g, S, S, 6, 93);
    },
    concrete(g, lg, S, r, lr) {
      g.fillStyle = '#B5B7B6'; g.fillRect(0, 0, S, S);
      blotches(g, S, S, 60, '#A2A4A3', 94, 30); blotches(g, S, S, 30, '#C4C6C5', 95, 20);
      g.fillStyle = 'rgba(0,0,0,.12)';
      for (let y = 0; y < S; y += 128) g.fillRect(0, y, S, 2);
      for (let x = 0; x < S; x += 128) g.fillRect(x, 0, 2, S);
      g.fillStyle = 'rgba(0,0,0,.28)';
      for (let y = 16; y < S; y += 64) for (let x = 16; x < S; x += 32) { g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill(); }
      for (let y = 0; y < S; y += 128) {
        for (let x = 0; x < S; x += 64) { pane(g, x + 2, y + 52, 60, 46, r, { curtains: true, top: [140, 152, 160], bot: [48, 56, 64] }); litPane(lg, x + 2, y + 52, 60, 46, lr, 0.36, false); }
        g.fillStyle = '#2A2F33'; for (let x = 0; x <= S; x += 64) g.fillRect(x - 1, y + 52, 3, 46);
        g.fillStyle = '#2A2F33'; g.fillRect(0, y + 50, S, 2); g.fillRect(0, y + 98, S, 2);
        g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(0, y + 100, S, 5);
      }
      grain(g, S, S, 10, 96);
    },
  };

  const facade = {} as Record<FacadeKey, FacadeTexture>;
  const facadeCanvases: Partial<Record<FacadeKey, HTMLCanvasElement>> = {};
  const paintSet = <K extends string>(painters: Record<K, Painter>, keys: K[], prefix: string, seedA: number, stepA: number, seedB: number, stepB: number): void => {
    keys.forEach((kind, i) => {
      const S = 512;
      const [c, g] = mkCanvas(S, S);
      const [lc, lg] = mkCanvas(S, S);
      lg.fillStyle = '#000';
      lg.fillRect(0, 0, S, S);
      painters[kind](g, lg, S, mulberry32(seedA + i * stepA), mulberry32(seedB + i * stepB));
      const key = (prefix + kind) as FacadeKey;
      facadeCanvases[key] = c;
      facade[key] = { tex: toTex(c), lit: toTex(lc), U: 3.0, V: 1.5 };
    });
  };
  paintSet(REAL, ['glass', 'office', 'apartment', 'brick'], '', 131, 17, 71, 29);
  paintSet(MODERN, ['glass', 'band', 'resi', 'terracotta'], 'm_', 211, 13, 97, 31);
  paintSet(URBAN, ['glass', 'panel', 'grid', 'concrete'], 'u_', 511, 19, 173, 37);

  {
    const S = 128;
    const [c, g] = mkCanvas(S, S);
    const [lc, lg] = mkCanvas(S, S);
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, S, S); lg.fillStyle = '#000'; lg.fillRect(0, 0, S, S);
    const lr = mulberry32(5);
    for (let y = 0; y < S; y += 64) for (let x = 0; x < S; x += 64) {
      g.fillStyle = '#9EB2DA'; g.fillRect(x + 17, y + 20, 30, 26);
      g.fillStyle = 'rgba(255,255,255,.6)'; g.fillRect(x + 20, y + 23, 7, 20);
      if (lr() < 0.4) { lg.fillStyle = '#FFD28A'; lg.fillRect(x + 17, y + 20, 30, 26); }
    }
    facade.toy = { tex: toTex(c), lit: toTex(lc), U: 2.2, V: 1.5 };
  }
  {
    const S = 256;
    const [c, g] = mkCanvas(S, S);
    const [lc, lg] = mkCanvas(S, S);
    const r = mulberry32(606);
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, S, S); lg.fillStyle = '#000'; lg.fillRect(0, 0, S, S);
    for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
      const X = cx * 128, Y = cy * 128;
      g.fillStyle = 'rgba(80,60,90,.06)'; roundRectPath(g, X + 21, Y + 25, 86, 72, 27); g.fill();
      const gr = g.createLinearGradient(X, Y + 22, X, Y + 94); gr.addColorStop(0, '#D3E6FF'); gr.addColorStop(1, '#A2C2F2');
      g.fillStyle = gr; roundRectPath(g, X + 24, Y + 22, 80, 68, 24); g.fill();
      g.fillStyle = 'rgba(255,255,255,.85)'; roundRectPath(g, X + 34, Y + 30, 14, 28, 7); g.fill();
      g.fillStyle = '#FFFFFF'; g.fillRect(X + 62, Y + 22, 4, 68);
      if (r() < 0.55) { g.fillStyle = ['#FFB3C7', '#FFD27A', '#B9E6A5'][(r() * 3) | 0]!; roundRectPath(g, X + 30, Y + 95, 68, 14, 7); g.fill(); }
      if (r() < 0.45) { lg.fillStyle = '#FFD99A'; roundRectPath(lg, X + 24, Y + 22, 80, 68, 24); lg.fill(); }
    }
    facade.soft = { tex: toTex(c, 1 / 1.2, 1 / 0.9), lit: toTex(lc, 1 / 1.2, 1 / 0.9), U: 1.2, V: 0.9 };
  }

  let c: HTMLCanvasElement, g: Ctx;
  [c, g] = mkCanvas(256, 256); g.fillStyle = '#7F9C66'; g.fillRect(0, 0, 256, 256);
  blotches(g, 256, 256, 90, '#5A7A48', 21); blotches(g, 256, 256, 60, '#A2B67F', 22); blotches(g, 256, 256, 30, '#8C8A5E', 24, 10); grain(g, 256, 256, 34, 23);
  const grass = toTex(c, 90, 90), grassPad = toTex(c, 3, 3);

  [c, g] = mkCanvas(256, 256); g.fillStyle = '#4C4F54'; g.fillRect(0, 0, 256, 256);
  blotches(g, 256, 256, 60, '#3E4145', 31, 30); blotches(g, 256, 256, 40, '#5F6267', 33, 18); grain(g, 256, 256, 30, 32);
  g.strokeStyle = 'rgba(25,25,28,.5)'; g.lineWidth = 1;
  const cr = mulberry32(34);
  for (let i = 0; i < 6; i++) { g.beginPath(); let x = cr() * 256, y = cr() * 256; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (cr() - 0.5) * 30; y += cr() * 20; g.lineTo(x, y); } g.stroke(); }
  const asphaltV = toTex(c, 1, 60), asphaltH = toTex(c, 60, 1);

  [c, g] = mkCanvas(128, 128); g.fillStyle = '#ABA79F'; g.fillRect(0, 0, 128, 128);
  const pr = mulberry32(41);
  for (let y = 0, row = 0; y < 128; y += 16, row++) for (let x = row % 2 ? -16 : 0; x < 128; x += 32) { const v = 156 + ((pr() * 24) | 0); g.fillStyle = `rgb(${v},${v - 3},${v - 9})`; g.fillRect(x + 1, y + 1, 30, 14); }
  grain(g, 128, 128, 14, 42);
  const sidewalk = toTex(c, 12, 12);

  [c, g] = mkCanvas(128, 128); g.fillStyle = '#B4AB9D'; g.fillRect(0, 0, 128, 128);
  const sr2 = mulberry32(43);
  for (let y = 0; y < 128; y += 32) for (let x = 0; x < 128; x += 32) { const v = 196 + ((sr2() * 24) | 0); g.fillStyle = `rgb(${v},${v - 6},${v - 16})`; g.fillRect(x + 1, y + 1, 30, 30); }
  blotches(g, 128, 128, 20, '#9E9484', 44, 10); grain(g, 128, 128, 16, 45);
  const stone = toTex(c, 6, 6);

  [c, g] = mkCanvas(128, 128); g.fillStyle = '#8B8984'; g.fillRect(0, 0, 128, 128); blotches(g, 128, 128, 40, '#6E6C68', 51, 16); grain(g, 128, 128, 46, 52);
  const gravel = toTex(c);

  [c, g] = mkCanvas(128, 128); g.fillStyle = '#6E5E56'; g.fillRect(0, 0, 128, 128);
  const tr = mulberry32(53);
  for (let y = 0; y < 128; y += 10) { g.fillStyle = 'rgba(30,22,18,.45)'; g.fillRect(0, y, 128, 2); for (let x = (y / 10) % 2 ? 8 : 0; x < 128; x += 16) { g.fillStyle = `rgba(0,0,0,${tr() * 0.15})`; g.fillRect(x, y + 2, 15, 8); } }
  grain(g, 128, 128, 18, 54);
  const roofTiles = toTex(c, 2, 2);

  // realistic storefronts
  let lc: HTMLCanvasElement, lg: Ctx;
  [c, g] = mkCanvas(512, 128); [lc, lg] = mkCanvas(512, 128); lg.fillStyle = '#000'; lg.fillRect(0, 0, 512, 128);
  g.fillStyle = '#393A3D'; g.fillRect(0, 0, 512, 128);
  {
    const s0 = mulberry32(77);
    const signs: RGB[] = [[47, 72, 88], [122, 58, 56], [214, 206, 190], [62, 86, 65], [90, 78, 122], [138, 109, 59], [42, 42, 46]];
    for (let i = 0; i < 4; i++) {
      const X = i * 128, sc = signs[(s0() * signs.length) | 0]!;
      g.fillStyle = rgba(sc, 1); g.fillRect(X + 5, 4, 118, 22);
      g.fillStyle = sc[0] + sc[1] + sc[2] > 480 ? 'rgba(40,40,40,.85)' : 'rgba(255,255,255,.85)';
      let tx0 = X + 14 + s0() * 20;
      for (let k = 0; k < 3 + ((s0() * 3) | 0); k++) { const w = 8 + s0() * 12; g.fillRect(tx0, 11, w, 8); tx0 += w + 4; }
      lg.fillStyle = rgba(sc.map((v) => Math.min(255, v + 90)), 0.95); lg.fillRect(X + 5, 4, 118, 22);
      const gi = g.createLinearGradient(0, 34, 0, 124); gi.addColorStop(0, '#6C5F52'); gi.addColorStop(1, '#2A2522');
      g.fillStyle = gi; g.fillRect(X + 9, 34, 110, 90);
      g.fillStyle = 'rgba(0,0,0,.25)'; for (let yy = 58; yy < 124; yy += 20) g.fillRect(X + 9, yy, 110, 3);
      g.fillStyle = 'rgba(255,255,255,.09)'; g.beginPath(); g.moveTo(X + 40, 34); g.lineTo(X + 72, 34); g.lineTo(X + 34, 124); g.lineTo(X + 9, 124); g.closePath(); g.fill();
      g.fillStyle = '#8C8983'; g.fillRect(X, 0, 5, 128); g.fillRect(X + 62, 34, 3, 90);
      if (s0() < 0.85) { lg.fillStyle = `rgba(255,${196 + ((s0() * 44) | 0)},${130 + ((s0() * 50) | 0)},${0.6 + s0() * 0.4})`; lg.fillRect(X + 9, 34, 110, 90); }
    }
    grain(g, 512, 128, 12, 78);
  }
  const store = toTex(c), storeLit = toTex(lc);

  // modern storefronts
  [c, g] = mkCanvas(512, 128); [lc, lg] = mkCanvas(512, 128);
  lg.fillStyle = '#000'; lg.fillRect(0, 0, 512, 128);
  g.fillStyle = '#2E3236'; g.fillRect(0, 0, 512, 128);
  {
    const r = mulberry32(301), fascia: RGB[] = [[46, 50, 54], [234, 230, 222], [62, 84, 78], [120, 72, 58]];
    for (let i = 0; i < 4; i++) {
      const X = i * 128, fc = fascia[(r() * fascia.length) | 0]!, light = fc[0] + fc[1] + fc[2] > 480;
      g.fillStyle = rgba(fc, 1); g.fillRect(X, 0, 128, 24);
      g.fillStyle = light ? 'rgba(40,40,40,.9)' : 'rgba(255,255,255,.92)';
      let tx = X + 18 + r() * 18;
      for (let k = 0; k < 3 + ((r() * 2) | 0); k++) { const w = 7 + r() * 10; g.fillRect(tx, 9, w, 6); tx += w + 3; }
      lg.fillStyle = light ? 'rgba(255,236,200,.5)' : 'rgba(255,255,255,.9)'; lg.fillRect(X + 16, 8, 80, 8);
      const gi = g.createLinearGradient(0, 28, 0, 128); gi.addColorStop(0, '#7B6A58'); gi.addColorStop(1, '#2C2723');
      g.fillStyle = gi; g.fillRect(X + 4, 28, 120, 100);
      g.fillStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.moveTo(X + 30, 28); g.lineTo(X + 60, 28); g.lineTo(X + 24, 128); g.lineTo(X + 4, 128); g.closePath(); g.fill();
      g.fillStyle = '#1D2023'; g.fillRect(X, 24, 4, 104); g.fillRect(X + 84, 28, 2, 100);
      if (r() < 0.9) { lg.fillStyle = `rgba(255,${205 + ((r() * 35) | 0)},${150 + ((r() * 40) | 0)},${0.7 + r() * 0.3})`; lg.fillRect(X + 4, 28, 120, 100); }
    }
  }
  const storeM = toTex(c), storeMLit = toTex(lc);

  [c, g] = mkCanvas(128, 128); g.shadowColor = 'rgba(0,0,0,1)'; g.shadowBlur = 22; g.fillStyle = '#000'; g.fillRect(28, 28, 72, 72);
  const ao = maskTex(c);
  [c, g] = mkCanvas(64, 64);
  {
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,.35)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  }
  const glow = maskTex(c);
  [c, g] = mkCanvas(8, 128);
  {
    const bgr = g.createLinearGradient(0, 0, 0, 128);
    bgr.addColorStop(0, 'rgba(255,255,255,0)'); bgr.addColorStop(0.6, 'rgba(255,255,255,.35)'); bgr.addColorStop(1, 'rgba(255,255,255,.95)');
    g.fillStyle = bgr; g.fillRect(0, 0, 8, 128);
  }
  const beam = maskTex(c);
  [c, g] = mkCanvas(256, 72);
  g.fillStyle = '#2F5BEA'; g.fillRect(0, 0, 256, 72);
  g.fillStyle = '#fff'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('GAME', 128, 38);
  const sign = toTex(c);
  sign.wrapS = sign.wrapT = ClampToEdgeWrapping;

  return {
    facade,
    facadeCanvases,
    grass, grassPad, asphaltV, asphaltH, sidewalk, stone, gravel, roofTiles,
    glassBand: toTex(facadeCanvases.glass!, 3, 3),
    glassBandM: toTex(facadeCanvases.m_glass!, 3, 3),
    glassBandU: toTex(facadeCanvases.u_glass!, 3, 3),
    store, storeLit, storeM, storeMLit, ao, glow, beam, sign,
    dispose() {
      for (const t of all) t.dispose();
    },
  };
}
