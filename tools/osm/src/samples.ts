/**
 * Built-in sample areas and package paths.
 *
 * @module
 */

import { fileURLToPath } from 'node:url';
import type { BBox } from './types.js';

/** A named sample area. */
export interface SampleArea {
  name: string;
  bbox: BBox;
}

/** Sample areas for `maprama-osm sample <id>`. */
export const SAMPLES: Record<string, SampleArea> = {
  seongsu: {
    name: 'Seongsu-dong, Seoul',
    bbox: { south: 37.541, west: 127.052, north: 37.548, east: 127.061 },
  },
};

/** Absolute path of the `tools/osm` package root (works from `src/` and `dist/`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
