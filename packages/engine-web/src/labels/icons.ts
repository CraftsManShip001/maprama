/**
 * Label icons and default label text, ported verbatim from the prototype:
 * the holo icon set `HI` (20×20 line icons whose accent uses `var(--c)`), the
 * compact POI badge glyphs used by the DOM styles, category colors and
 * default subtitles.
 *
 * @module
 */

import type { LabelIcon, PoiCategory } from '@maprama/protocol';

/** Holo icon SVG markup per label icon (prototype `HI`). */
export const HOLO_ICONS: Readonly<Record<LabelIcon, string>> = Object.freeze({
  avenue: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6.5 17 9 3M13.5 17 11 3\"/><path d=\"M10 5.2v1.6M10 9.2v1.6M10 13.2v1.8\" style=\"stroke:var(--c)\" stroke-width=\"1.8\"/></svg>",
  street: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10 18V9.5\"/><path d=\"M4 3.8h9.2L15.8 6l-2.6 2.2H4z\" style=\"fill:var(--c);fill-opacity:.32\"/><path d=\"M7 18h6\"/></svg>",
  district: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10 18s5.6-5 5.6-9.3a5.6 5.6 0 0 0-11.2 0C4.4 13 10 18 10 18z\"/><circle cx=\"10\" cy=\"8.7\" r=\"2.2\" style=\"fill:var(--c)\" stroke=\"none\"/></svg>",
  water: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M2.8 8.6c1.8-1.6 3.6 1.6 5.4 0s3.6 1.6 5.4 0 2.6 1 3.6.4M2.8 13c1.8-1.6 3.6 1.6 5.4 0s3.6 1.6 5.4 0 2.6 1 3.6.4\"/><circle cx=\"15.6\" cy=\"4.4\" r=\"1.6\" style=\"fill:var(--c)\" stroke=\"none\"/></svg>",
  subway: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"5\" y=\"2.8\" width=\"10\" height=\"11.6\" rx=\"3\"/><rect x=\"7\" y=\"4.8\" width=\"6\" height=\"2.6\" rx=\".9\" style=\"fill:var(--c)\" stroke=\"none\"/><path d=\"M5 9.4h10\"/><circle cx=\"7.8\" cy=\"11.8\" r=\".6\" fill=\"currentColor\"/><circle cx=\"12.2\" cy=\"11.8\" r=\".6\" fill=\"currentColor\"/><path d=\"m7.2 17.4 1.4-3M12.8 17.4l-1.4-3\"/></svg>",
  cafe: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 8.8h9v3.8A3.6 3.6 0 0 1 9.4 16.2H7.6A3.6 3.6 0 0 1 4 12.6z\" style=\"fill:var(--c);fill-opacity:.32\"/><path d=\"M13 10h1.2a1.9 1.9 0 0 1 0 3.8H13\"/><path d=\"M7 3.2c-.9 1 .9 1.9 0 3.1M10 3.2c-.9 1 .9 1.9 0 3.1\"/></svg>",
  store: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4.4 6.8h11.2l-.9 9.6a1.3 1.3 0 0 1-1.3 1.2H6.6a1.3 1.3 0 0 1-1.3-1.2z\" style=\"fill:var(--c);fill-opacity:.32\"/><path d=\"M7.4 9V5.9a2.6 2.6 0 0 1 5.2 0V9\"/></svg>",
  music: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"8.6\" cy=\"11\" r=\"6\"/><circle cx=\"8.6\" cy=\"11\" r=\"2\" style=\"fill:var(--c)\" stroke=\"none\"/><path d=\"M14.6 2.8v6.4M14.6 2.8c1.5.3 2.5 1.3 2.7 2.7\"/></svg>",
  school: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10 3.8 2.4 7.4 10 11l7.6-3.6z\" style=\"fill:var(--c);fill-opacity:.32\"/><path d=\"M5.4 9.1v3.7c1.2 1.3 2.8 2 4.6 2s3.4-.7 4.6-2V9.1M17.6 7.4v4.2\"/></svg>",
  book: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10 5.4C8.5 4.2 6.4 3.9 3.4 4.1v10.8c3-.2 5.1.1 6.6 1.3 1.5-1.2 3.6-1.5 6.6-1.3V4.1c-3-.2-5.1.1-6.6 1.3z\"/><path d=\"M10 5.4v10.8\"/><path d=\"M5.6 7.3c1.1 0 2 .2 2.8.6M11.6 7.9c.8-.4 1.7-.6 2.8-.6\" style=\"stroke:var(--c)\"/></svg>",
  plaza: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"10\" cy=\"10\" r=\"7\"/><path d=\"m10 5.9 1.2 2.4 2.7.4-2 1.9.5 2.6L10 12l-2.4 1.2.5-2.6-2-1.9 2.7-.4z\" style=\"fill:var(--c)\" stroke=\"none\"/></svg>",
  park: "<svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10 3.2a4.3 4.3 0 0 1 4.1 5.6 3.4 3.4 0 0 1-1.2 6.4H7.1A3.4 3.4 0 0 1 5.9 8.8 4.3 4.3 0 0 1 10 3.2z\" style=\"fill:var(--c);fill-opacity:.32\"/><path d=\"M10 9.4v8.4M10 12.6 8 11.1M10 11.6l2-1.5\"/></svg>",
});

/** Short Korean names of the icons (prototype `HI_LABEL`). */
export const ICON_LABELS: Readonly<Record<LabelIcon, string>> = Object.freeze({"avenue": "대로", "street": "도로", "district": "동", "water": "강", "subway": "지하철", "cafe": "카페", "store": "편의점", "music": "음반", "school": "학교", "book": "서점", "plaza": "광장", "park": "공원"});

/** Accent color per icon (prototype icon sheet / `POI_STYLE`). */
export const ICON_COLORS: Readonly<Record<LabelIcon, string>> = Object.freeze({"avenue": "#E3A23B", "street": "#3E7BFA", "district": "#7B61FF", "water": "#2E9BD6", "subway": "#2E9E6B", "cafe": "#9B6B43", "store": "#E0823A", "music": "#7B5CD6", "school": "#4A7BD1", "book": "#3F8F8A", "plaza": "#2F5BEA", "park": "#4E9B55"});

/** Compact white glyph per POI category for DOM badge labels (prototype `POI_STYLE`). */
export const POI_GLYPHS: Readonly<Record<PoiCategory, string>> = Object.freeze({
  subway: "M",
  cafe: "<svg viewBox=\"0 0 16 16\"><path d=\"M3 5h8v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM11 6h1.5a1.5 1.5 0 0 1 0 3H11\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.6\"/></svg>",
  store: "<svg viewBox=\"0 0 16 16\"><path d=\"M3.5 5.5h9l-.8 8H4.3zM6 5.5V4a2 2 0 0 1 4 0v1.5\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.6\"/></svg>",
  music: "<svg viewBox=\"0 0 16 16\"><path d=\"M6 12.2V3.8l6.5-1.6v8.4\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.6\"/><circle cx=\"4.6\" cy=\"12.3\" r=\"1.8\" fill=\"#fff\"/><circle cx=\"11.1\" cy=\"10.7\" r=\"1.8\" fill=\"#fff\"/></svg>",
  school: "<svg viewBox=\"0 0 16 16\"><path d=\"M8 2.5 2 5.5l6 3 6-3zM4.5 7v3.5c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5V7\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.5\"/></svg>",
  book: "<svg viewBox=\"0 0 16 16\"><path d=\"M3 3.5h4c.4 0 .8.2 1 .5.2-.3.6-.5 1-.5h4v9H9c-.4 0-.8.2-1 .5-.2-.3-.6-.5-1-.5H3zM8 4v9\" fill=\"none\" stroke=\"#fff\" stroke-width=\"1.4\"/></svg>",
  plaza: "<svg viewBox=\"0 0 16 16\"><path d=\"m8 2 1.8 4 4.2.4-3.2 2.8 1 4.2L8 11.2l-3.8 2.2 1-4.2L2 6.4l4.2-.4z\" fill=\"#fff\"/></svg>",
  park: "<svg viewBox=\"0 0 16 16\"><path d=\"M8 2.5 4 8h2.5L4 11.5h8L9.5 8H12zM8 11.5V14\" fill=\"#fff\" stroke=\"#fff\" stroke-width=\".6\"/></svg>",
});

/** Default POI subtitle per category (prototype `POI_SUB`). */
export const POI_SUBTITLES: Readonly<Record<PoiCategory, string>> = Object.freeze({"subway": "지하철역 · STATION", "cafe": "카페 · CAFE", "store": "편의점 · STORE", "music": "음반 · RECORDS", "school": "학교 · SCHOOL", "book": "서점 · BOOKS", "plaza": "광장 · PLAZA", "park": "공원 · PARK"});

/** Default road / district subtitles (prototype holo labels). */
export const KIND_SUBTITLES = Object.freeze({ avenue: '대로 · AVENUE', street: '도로 · STREET', district: '동 · DISTRICT', water: '하천 · RIVER' });
