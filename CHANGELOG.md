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

- `camera:idle`, a subscription topic that fires **once** when the camera comes
  to rest — 150 ms (`CAMERA_IDLE_DELAY_MS`) after the last movement of a
  gesture, a zoom button, a `setCamera` / `fitBounds` animation or a followed
  character settling — so an app no longer has to debounce `camera:change` and
  unproject the four corners itself. The payload carries the resting `camera`,
  the ground `bounds` (`{ ne, sw }`, the north-aligned box around the visible
  area), a **required** `radiusMeters`, and an honest `reason`. `radiusMeters`
  measures from `camera.center` to the *farthest corner of the visible area* —
  the circumscribed radius, so a "give me everything within R of here" query
  never drops the POIs sitting in the corners of the screen; a tilted camera
  looking towards the horizon is clamped to `CAMERA_IDLE_HORIZON_FACTOR` (6) ×
  `camera.distance`, the engine's far plane, so the numbers are always finite
  and describe ground that is really drawn. `reason` is `'gesture'` for user
  input **including the engine's own zoom buttons** (the user presses them; the
  app never issues them), `'api'` for the app's `setCamera` / `fitBounds`, and
  `'follow'` for the camera catching up with a followed character. Subscribing
  arms one event, so the first query happens without waiting for the user to
  touch the map. React Native: `ref.subscribe('camera:idle', …)` and the
  `useCameraIdle(map, { throttleMs })` hook.
- `ui.contentInset` (`{ top?, right?, bottom?, left? }` in dp) on `MapUiSpec`
  tells the engine which edges of the map view app chrome covers — a bottom
  sheet, a top bar. The map keeps rendering across the whole view; what moves is
  everything that means "where the user is looking": a `setCamera` `center`
  lands at the centre of the *visible* area (and is reported back as such by
  `camera:change`, `camera:idle` and `fitBounds`), a followed character stays
  above the sheet, the engine ornaments move inside the inset, labels and
  markers are placed and clamped there, `ScreenPoint.visible` (`project`,
  `overlay:positions`) means "inside the visible area", `fitBounds` adds the
  inset to its padding, and `camera:idle` reports the visible area's `bounds`
  and `radiusMeters`. **The attribution stays engine-drawn and moves with the
  inset**: a sheet can no longer cover `© OpenStreetMap` while
  `attribution: true`, which is a data-licensing requirement and not a cosmetic
  one — switching the attribution off and redrawing it in the app would go stale
  the moment the library changes its wording or its sources.
  `project` / `unproject` keep working in **full-view screen coordinates** with
  the origin at the top left of the whole map view; the inset never moves the
  coordinate frame. The native engine (`engine="native"`) validates and stores
  the inset and applies it to `camera:idle` and label placement, but does not
  move the MapLibre camera or the platform ornaments yet and warn-logs once
  (`packages/engine-native/DESIGN.md` §11.1 lists what remains).
- Camera distance limits in **metres**: `minDistanceMeters` / `maxDistanceMeters`
  on `CameraSpec` — the `camera` prop of `<MapramaView>` and `ref.setCamera` —
  bound the camera independently of the world's `unitMeters`, on every path that
  changes the distance (`setCamera`, `zoom`, pinch, wheel, the zoom buttons,
  `follow` and the zoom-out behaviour). The defaults are unchanged (14 / 150
  world units, 112 m – 1,200 m at 8 m per unit), so a map that sets neither looks
  exactly as it did. Widening the range also widens the fog, shadow and frustum
  ranges with the camera — at and below 150 world units every number is
  unchanged, above it they scale with `distance / 150`, so a 3 km view fades out
  at the same place on screen as a 1.2 km one instead of drowning in fog. A range
  the renderer cannot serve (outside 2 – 1,000 world units) is narrowed and
  reported once as a non-fatal `error` with code `camera_limits_clamped`.
- `ref.fitBounds(bounds, options?)` frames a `{ ne, sw }` box: padding in dp per
  side, the current pitch / bearing kept (or dropped to straight-down-to-north
  when that is the only way the box fits, `orientation`), optional `animate`, and
  a result that says where the camera went, whether the box really `fitted`, and
  whether the distance limits decided the distance. Protocol: the optional
  `fitBounds` request method and `LngLatBounds` (`PROTOCOL_VERSION` unchanged).
- `CAMERA_FOV_DEG` (40) and `visibleSpanMeters(distanceMeters)` are public, so
  apps no longer hard-code the field of view to turn a camera distance into the
  ground span it shows.
- Markers: `<MarkerLayer>` draws app-owned map pins in the engine — fixed
  screen size, pin tip on the coordinate, custom SVG or built-in `pin` / `dot`
  shapes tinted per marker, priority-based collision shared with the map labels
  (`alwaysVisible` and the selected marker are never hidden), a per-marker
  accessibility label, and a `marker:press` that reports the marker's screen
  point and takes precedence over `building:press` / `map:press`. Markers are
  matched by id, so an update that only changes colours or the selection
  neither reloads an icon nor recreates a view. Protocol: the optional
  `setMarkerLayer` / `removeMarkerLayer` commands and the `marker:press` event
  (`PROTOCOL_VERSION` unchanged). Implemented by `@maprama/engine-web`; the
  native engine validates and ignores the commands for now.
- `@maprama/react-native`: `<MapramaView>` with `Character`, `CharacterLayer`,
  `DropLayer` (app data or the hosted service), `MarkerLayer`, `Geofence` and `MapOverlay`,
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
- engine-web: the **shadow map is only redrawn when something that casts or
  receives a shadow changed.** Before, three re-rendered the whole 2048² PCF
  depth pass on every drawn frame, including frames drawn only to rotate or
  zoom the camera (which does not move the sun), to fade a DOM label out, or to
  move host overlays. A frame now keeps the previous shadow map unless the sun
  or the shadow frustum moved, a subsystem that touches the 3D scene is still
  animating, or something changed the scene from outside a frame. On a quiet
  town (`street.traffic: false`, reduced motion) rotating the camera spends
  0.02 ms per frame on shadows instead of 1.05 ms, and the whole frame drops
  from 2.46 ms to 1.71 ms. Scenes that really move — characters, ambient
  traffic, a spinning landmark — redraw the map exactly as before. The
  resolution is also halved to 1024² on phones and tablets, where that depth
  pass is pure fill; desktop browsers keep 2048².
- engine-web: `overlay:positions` no longer projects anchors on frames that
  cannot send them. The 33 ms throttle is now checked before any projection
  work, anchor world positions are cached until the anchor set or the world
  changes, and the per-frame batch is built in a reused buffer, so tracking 40
  host overlays allocates ~6× less and does ~55% fewer projections while
  panning. The event still carries **every** anchor, unchanged: hosts may read
  it as the complete current state, and an off-screen anchor's `x`/`y` is used
  by `<MapOverlay hideWhenOffscreen={false}>`.

### Fixed

- engine-web: a `WorldData` world no longer gets a building that is not in the
  data. When such a world had a `plaza` with no footprint over or near it, the
  engine synthesised an 8-unit glass landmark tower at that point — a building
  that does not exist on the ground, invisible in the building count (it was
  added after the count), and animated, so its spinning top also kept the
  on-demand render loop awake forever. The `plaza` itself is unchanged: it
  still draws the plaza ground and benches and still frames the default
  camera. Maps that relied on that decoration should add a real building to
  `buildings[]`, or place their own overlay, model or character at the plaza
  coordinates. The procedural `town` and `grid` layouts are untouched and keep
  their landmark — those worlds are generated, not real-world data.
- `@maprama/osm`: `build` now warns on stderr when the `plaza` it emits is more
  than 15 m from every building footprint (and inside none), reporting the
  distance to the nearest one. The output is unchanged — a square in open space
  is correct data — but anything anchored at `world.plaza` will have nothing
  under it, and that is now visible at build time instead of being papered over
  by a fake tower. `buildWorld()` gained an optional `warn` sink for the same
  messages; without it nothing is logged.
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
