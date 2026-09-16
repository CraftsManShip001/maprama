# Changelog

All notable changes to the published Maprama packages are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the packages follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, minor versions may contain breaking changes.

All packages in this repository share one version number.

## [0.1.0] — Unreleased

First public release of `@maprama/protocol`, `@maprama/engine-web`,
`@maprama/react-native`, `@maprama/osm` and `@maprama/assets`. The v2 native engine
(`@maprama/engine-native`) is in development and not part of this release.

### Added

- `@maprama/react-native`: `<MapramaView>` with `Character`, `CharacterLayer`,
  `DropLayer` (app data or the hosted service), `Geofence` and `MapOverlay`,
  the `ref` API (`travel`, `setCamera`, `project`, `route`, `subscribe`, …),
  `useCharacterPosition` / `useCameraState` hooks, the WebView engine host and
  an Expo config plugin.
- `@maprama/engine-web`: three.js engine implementing the whole protocol
  (worlds, themes, buildings, labels, characters, travel, drops, geofences,
  map UI), shipped as an ESM library, an IIFE bundle and a single-file HTML
  document for WebView hosts.
- `@maprama/protocol`: shared types, the message codec with validation, geo
  projection and theme presets (also as JSON under `themes/*.json`).
- `@maprama/osm`: `maprama-osm` CLI and `buildWorld()` to build `WorldData`
  from OpenStreetMap (Overpass), with optional Korean building heights and the
  Seongsu-dong sample world (ODbL).
- `@maprama/assets`: `maprama` CLI to inspect and optimise glTF/GLB models.
- Travel time scale: travel runs at real speed by default; `timeScale` on the
  `travel` command, `TravelOptions.timeScale` and the `travelTimeScale` prop of
  `MapramaView` select a speed multiplier.
- Android support.
- Documentation site on GitHub Pages: <https://craftsmanship001.github.io/maprama/>.
- Example app updates: a feature catalog screen per feature, including a ×20
  travel playback demo, verified on iOS and Android with Maestro.
- `@maprama/osm`: `--kr-fill-missing` (and the `krFillMissing` option of
  `buildWorld`) uses the Korean national building dataset passed with
  `--kr-buildings` as a footprint source, not only as a height source. Where OSM
  has no building, the dataset polygon is emitted as a building with that
  record's height and floor count — useful outside dense Seoul, where OSM
  building coverage is patchy and POI pins can otherwise land on empty ground.
  Duplicates are avoided with the existing 50%-overlap / centroid rule, applied
  in both directions; generated buildings get `k`-prefixed ids hashed from the
  source geometry, so they are stable and cannot collide with OSM ids. The build
  stats gained `buildingsFromOsm`, `buildingsFilled` and `krFillSkipped`. Off by
  default: existing pipelines are unchanged.
- Release tooling: package metadata, per-package READMEs, `LICENSE` / `NOTICE`
  in every tarball, GitHub Actions CI, `CONTRIBUTING.md` and `SECURITY.md`.

### Changed

- The project was renamed from Diorama to **Maprama**; every package now lives
  under the `@maprama/` scope.
- engine-web renders **on demand**. The `requestAnimationFrame` loop keeps
  ticking, but a frame is only drawn (and the simulation only advances) while
  something asked for one: a command, a gesture, an async asset, or a
  subsystem that is animating. A map nobody is touching costs no frames, which
  is what a WebView pays for in battery. Hosts see no behavioural change;
  code using the internal `scene` API must call `scene.requestRender()` after
  changing the scene outside a frame hook, and hold
  `scene.addActiveSource(tag)` while animating something itself.

### Fixed

- Walk / run animation cadence now follows the ground a character actually
  covers (metres per second) instead of its speed in world units, so the walk
  clip plays at 1× at the natural walking speed (4.8 km/h) at every world scale
  (`unitMeters`) and the feet stay planted. Before, a character travelling at
  real-world speed (`travelTimeScale: 1`) played its walk clip about ten times
  too fast. Travel played back faster than real time is now animated as
  running: at `travelTimeScale: 20` the character covers twenty times the
  ground of a natural walk, so the `run` clip is chosen and plays at the
  maximum rate (2.2×) instead of reading as a very fast walk. No
  public API changed — the cadence helpers are internal to the engine and are
  not exported from `@maprama/engine-web`.
- Optional character fields can be reset to their defaults by sending `null`.
- Characters created without a model get the default body again.
- engine-web: the location puck no longer overlaps the HUD, labels are no
  longer clipped at the screen edges, plane name tags sit in the right place,
  and stray NUL bytes were removed from sources.

[0.1.0]: https://github.com/CraftsManShip001/maprama/releases/tag/v0.1.0
