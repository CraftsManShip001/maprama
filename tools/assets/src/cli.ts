/**
 * `diorama` command line interface (`inspect`, `optimize`).
 *
 * @module
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectFile } from './inspect.js';
import { FACINGS, optimizeFile, type Compression, type Facing } from './optimize.js';

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIO: CliIO = {
  stdout: (t) => process.stdout.write(`${t}\n`),
  stderr: (t) => process.stderr.write(`${t}\n`),
};

export const USAGE = `diorama: glTF/GLB tools for Diorama

Usage:
  diorama inspect <model.glb>
  diorama optimize <in.glb> -o <out.glb> [--max-triangles 20000] [--max-texture 1024]
                   [--draco | --meshopt] [--center-feet] [--face +z|-z|+x|-x]
                   [--scale-to-height 1.8] [--verbose]

--face gives the direction the SOURCE model faces; it is rotated to face +Z.`;

class UsageError extends Error {}

function positiveNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number, got "${value}"`);
  return n;
}

/** Runs the CLI; resolves to the exit code. */
export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'inspect': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: {} });
        if (positionals.length !== 1) throw new UsageError('inspect requires exactly one model path');
        const report = await inspectFile(resolve(positionals[0]!));
        io.stdout(JSON.stringify(report, null, 2));
        for (const w of report.warnings) io.stderr(`warning: ${w}`);
        return 0;
      }
      case 'optimize': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          strict: true,
          options: {
            output: { type: 'string', short: 'o' },
            'max-triangles': { type: 'string' },
            'max-texture': { type: 'string' },
            draco: { type: 'boolean' },
            meshopt: { type: 'boolean' },
            'center-feet': { type: 'boolean' },
            face: { type: 'string' },
            'scale-to-height': { type: 'string' },
            verbose: { type: 'boolean' },
          },
        });
        if (positionals.length !== 1 || !values.output) throw new UsageError('optimize requires <in> and -o <out>');
        if (values.draco && values.meshopt) throw new UsageError('--draco and --meshopt are mutually exclusive');
        if (values.face !== undefined && !(FACINGS as readonly string[]).includes(values.face)) {
          throw new UsageError(`--face must be one of ${FACINGS.join(', ')}`);
        }
        const compression: Compression = values.draco ? 'draco' : values.meshopt ? 'meshopt' : 'none';
        const input = resolve(positionals[0]!);
        const output = resolve(values.output);
        const report = await optimizeFile(input, output, {
          maxTriangles: positiveNumber('max-triangles', values['max-triangles']),
          maxTexture: positiveNumber('max-texture', values['max-texture']),
          compression,
          centerFeet: values['center-feet'] ?? false,
          face: values.face as Facing | undefined,
          scaleToHeight: positiveNumber('scale-to-height', values['scale-to-height']),
          log: values.verbose ? io.stderr : undefined,
        });
        const summary = {
          input,
          output,
          bytes: { before: (await stat(input)).size, after: (await stat(output)).size },
          triangles: { before: report.before.triangles, after: report.after.triangles },
          bounds: { before: report.before.bounds, after: report.after.bounds },
          textures: report.after.textures.map((t) => ({ name: t.name, width: t.width, height: t.height })),
          animations: report.after.animations.map((a) => a.name),
          steps: report.steps,
          warnings: report.warnings,
          ...(report.suggestedAnimations ? { suggestedAnimations: report.suggestedAnimations } : {}),
        };
        io.stdout(JSON.stringify(summary, null, 2));
        for (const w of report.warnings) io.stderr(`warning: ${w}`);
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    io.stderr(`diorama: ${message}`);
    if (e instanceof UsageError || (e instanceof TypeError && /option|argument/i.test(message))) {
      io.stderr(USAGE);
      return 2;
    }
    return 1;
  }
}
