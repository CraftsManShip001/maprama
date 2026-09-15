/**
 * Small, dependency-free math helpers shared by every module (safe to use in
 * node tests: no DOM, no WebGL).
 *
 * @module
 */

/** Deterministic PRNG (mulberry32), identical to the prototype's generator. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const clampi = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v | 0));
export const DEG = Math.PI / 180;

/** Smoothstep of an already clamped 0..1 value. */
export const smooth01 = (x: number): number => x * x * (3 - 2 * x);

/** Wraps an angle in degrees to (-180, 180]. */
export function wrapDeg(d: number): number {
  let r = ((d + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}

// ---------------------------------------------------------------------------
// sRGB hex color helpers. The prototype (three r128, manual color management)
// mixed and shifted colors on raw sRGB values; these helpers keep that math in
// sRGB so results match after porting to r186's automatic color management.
// ---------------------------------------------------------------------------

const ch = (hex: number, shift: number): number => (hex >> shift) & 255;
const toHex = (r: number, g: number, b: number): number =>
  (clampi(Math.round(r), 0, 255) << 16) | (clampi(Math.round(g), 0, 255) << 8) | clampi(Math.round(b), 0, 255);

/** Linear interpolation between two sRGB hex colors (in sRGB space). */
export function mixHex(a: number, b: number, t: number): number {
  return toHex(
    ch(a, 16) + (ch(b, 16) - ch(a, 16)) * t,
    ch(a, 8) + (ch(b, 8) - ch(a, 8)) * t,
    ch(a, 0) + (ch(b, 0) - ch(a, 0)) * t,
  );
}

/** Multiplies an sRGB hex color by a scalar (in sRGB space). */
export function scaleHex(a: number, k: number): number {
  return toHex(ch(a, 16) * k, ch(a, 8) * k, ch(a, 0) * k);
}

/** Offsets hue/saturation/lightness of an sRGB hex color (like three's `offsetHSL` in r128). */
export function offsetHslHex(hex: number, dh: number, ds: number, dl: number): number {
  const r = ch(hex, 16) / 255, g = ch(hex, 8) / 255, b = ch(hex, 0) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (min + max) / 2;
  if (min !== max) {
    const delta = max - min;
    s = l <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
    if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
  }
  h = (((h + dh) % 1) + 1) % 1;
  s = clamp(s + ds, 0, 1);
  const L = clamp(l + dl, 0, 1);
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
    return p;
  };
  if (s === 0) return toHex(L * 255, L * 255, L * 255);
  const q = L <= 0.5 ? L * (1 + s) : L + s - L * s;
  const p = 2 * L - q;
  return toHex(hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255);
}

/** Parses `#RGB`, `#RRGGBB` or `#RRGGBBAA` into a 24-bit number (alpha ignored). */
export function cssHexToNumber(css: string): number {
  let s = css.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length === 8) s = s.slice(0, 6);
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}
