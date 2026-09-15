/**
 * Shared glTF I/O with every extension and codec (Draco, Meshopt) registered.
 *
 * @module
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

let ioPromise: Promise<NodeIO> | undefined;

/** Returns a cached NodeIO able to read and write compressed glTF/GLB. */
export function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
    const [decoder, encoder] = await Promise.all([draco3d.createDecoderModule(), draco3d.createEncoderModule()]);
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': decoder,
      'draco3d.encoder': encoder,
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
  })();
  return ioPromise;
}
