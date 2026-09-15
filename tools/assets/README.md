# @maprama/assets

`maprama` is a CLI that inspects and optimizes user-supplied glTF 2.0 / GLB
models (characters, drops, vehicles and landmarks) so they work well in Maprama
engines. It is built on [glTF Transform](https://gltf-transform.dev),
[meshoptimizer](https://github.com/zeux/meshoptimizer), Draco and
[sharp](https://sharp.pixelplumbing.com).

```sh
npm run build -w @maprama/protocol
npm run build -w @maprama/assets
npm test -w @maprama/assets
```

## Engine conventions

| | Convention |
| --- | --- |
| Units | meters |
| Up | `+Y` |
| Forward | `+Z` (the model faces `+Z`) |
| Origin | at the feet (bottom center of the bounds) |
| Animation clips | `idle`, `walk`, `run`, `ride`, `wave` (or map them with `CharacterSpec.animations`) |

## `maprama inspect <model.glb>`

Prints a JSON report to stdout. Warnings are also printed to stderr. The report
contains:

- **`bounds`:** `min`, `max`, `size` and `center` in meters, for the default scene with node transforms applied.
- **`axes`:** guesses for `up` and `forward`, with a `confidence` and `notes`. The guesses come from bounding-box proportions, so treat them as hints. `±x` means the model probably faces along X but the sign cannot be inferred.
- **`triangles`, `vertices`, `meshes`, `primitives`, `materials`, `nodes`:** geometry and scene counts.
- **`textures[]`:** `name`, `uri`, `mimeType`, `width`, `height` and `bytes` for each texture.
- **`animations[]`:** `name`, `duration` and `channels` for each clip.
- **`clips`:**
  - `found`: clips that use a conventional name exactly.
  - `missing`: conventional names with no matching clip.
  - `mappingNeeded` and `suggestedMapping`: whether a `CharacterSpec.animations` mapping is needed, and a suggested one.
  - `unmatched`: clips that fit neither list.
- **`skinned`, `skins`, `joints`, `morphTargets`:** skinning and morph-target information.
- **`extensionsUsed`, `warnings`:** glTF extensions in use, and any warnings.

Examples of the synonyms used to suggest a mapping:

- `idle` ← Standing, Breathing
- `run` ← Jog, Sprint
- `ride` ← Bike, Bicycle, Cycling, Drive, Sitting
- `wave` ← Hello, Greet

Matching uses the last segment of names such as `Armature|mixamo.com|Walk`.

## `maprama optimize <in.glb> -o <out.glb> [options]`

| Option | Default | |
| --- | --- | --- |
| `--max-triangles <n>` | `20000` | Scene-wide triangle budget (meshoptimizer simplification) |
| `--max-texture <px>` | `1024` | Downscale textures larger than this, keeping aspect ratio |
| `--draco` / `--meshopt` | none | Geometry compression (mutually exclusive) |
| `--center-feet` | off | Move the origin to the bottom center of the bounds |
| `--face +z\|-z\|+x\|-x` | `+z` | The direction the **source** model faces. It is rotated about +Y to face +Z |
| `--scale-to-height <m>` | | Uniformly scale to this height |
| `--verbose` | | Log simplification passes |

The optimization pipeline runs these steps in order:

1. `dedup`, `prune`, `weld`, and `resample` (when the model has animations).
2. Normalize the model: face +Z, then scale to height, then move the origin to the feet. All scene roots are wrapped in a `maprama_root` node that carries this transform, which keeps skins and animation channels intact.
3. If the scene exceeds `--max-triangles`, `simplify` runs with increasing error bounds until the budget is met. A warning is printed if it cannot be met, for example because of morph targets.
4. Textures larger than `--max-texture` are resized with sharp, keeping their original format.
5. `prune` and `dedup` run again.
6. Draco or Meshopt compression is applied, if requested.

The output is re-read and inspected. The command prints a JSON summary with
before/after bytes, triangles, bounds and textures, plus the steps taken and any
warnings. When clip names do not follow the convention, the summary also
includes `suggestedAnimations`:

```jsonc
// maprama optimize hero.glb -o hero.opt.glb --center-feet --scale-to-height 1.8
"warnings": [
  "animation clip \"Armature|Walking\" does not match idle|walk|run|ride|wave",
  "suggested CharacterSpec.animations mapping: {\"walk\":\"Armature|Walking\"}"
],
"suggestedAnimations": { "walk": "Armature|Walking" }
```

Use it in the host:

```ts
const hero: CharacterSpec = {
  id: 'me',
  model: { uri: 'https://example.com/hero.opt.glb' },
  animations: { walk: 'Armature|Walking' },
};
```

### Notes

- **Compressed output needs a decoder in the engine:** Draco needs a Draco decoder (for example three.js `DRACOLoader`), and Meshopt needs `MeshoptDecoder`. Leave compression off if the target engine has no decoder configured.
- **KTX2/Basis texture compression is not included**, because it requires the native `toktx` tool.
- **Bounds of skinned meshes are computed from the bind pose** (mesh node transforms), so `--center-feet` and `--scale-to-height` are approximate for rigs whose armature node carries its own scale (common in FBX→glTF conversions). Re-run `inspect` on the output to check.
- **Z-up models:** `inspect` flags models that look Z-up, but `optimize` does not rotate them. Re-export them with +Y up.
