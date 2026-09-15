/**
 * `@maprama/assets`: inspect and optimize glTF/GLB models for Maprama engines.
 *
 * @packageDocumentation
 */

export { analyzeClips, clipWarnings, countTriangles, inspectDocument, inspectFile, sceneBounds } from './inspect.js';
export type { AxisGuess, ClipReport, InspectReport, TextureReport } from './inspect.js';
export { FACINGS, optimizeDocument, optimizeFile, yawForFacing } from './optimize.js';
export type { Compression, Facing, OptimizeOptions, OptimizeReport, OptimizeResult } from './optimize.js';
export { getIO } from './io.js';
