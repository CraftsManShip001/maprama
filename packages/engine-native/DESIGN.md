# `@diorama/engine-native` — native engine v2 design

Status: **M0 (foundation)**. This package contains:

- this design;
- the C++ core interfaces (`cpp/include/diorama/*.hpp`);
- a compilable core skeleton, a protocol conformance harness, and the MapLibre Native patch-queue tooling.

It does **not** contain a renderer yet. v1 ships `@diorama/engine-web`. The native engine must speak
exactly the same `@diorama/protocol` messages, so the React Native package can switch engines with a prop
(`engine="web" | "native"`) without API changes.

Evidence labels used below: **[V]** verified in this repository (a command or file is named),
**[E]** an estimate or target to be validated, **[U]** an unverified assumption about third-party code,
to be confirmed in milestone M1.

---

## 1. Constraints and decisions

| Topic | Decision |
| --- | --- |
| React Native | New Architecture only: a Fabric view plus a TurboModule over JSI. RN 0.76+, iOS 15.1+, Android API 24+. No bridge fallback. |
| Renderer base | Fork **MapLibre Native** (BSD-2-Clause) and embed it. The fork is kept as a **patch queue** (`patches/*.patch`) rebased on upstream, never as a long-lived divergent fork (§10). |
| Code sharing | One **C++ shared core** (protocol, simulation, diorama layer). Obj-C++ (iOS) and Kotlin/JNI (Android) wrappers stay thin (`ios/README.md`, `android/README.md`). |
| Contract | `@diorama/protocol` is the single source of truth. The core decodes envelopes **identically** to `decodeCommand`, and the conformance tests prove it against fixtures exported from the TS package on every `npm test` [V: `scripts/export-fixtures.mjs`, `cpp/tests/decode_tests.cpp`]. |
| Engine selection | The RN prop `engine="web" \| "native"`. Parity is tracked in §11. |
| C++ standard | C++17 for the core (it compiles inside RN's C++20 toolchains). Floating-point `std::to_chars` is avoided because it is unavailable on iOS < 16.3 [E]. The core uses `snprintf`/`strtod` shortest round-trip instead (`cpp/src/json.cpp`). |
| JSON | A small self-written parser with JavaScript semantics (`cpp/include/diorama/json.hpp`). §6.4 explains why this beat vendoring nlohmann/json. |

## 2. Layer stack

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TS API  (@diorama/react-native: <DioramaMap engine="native" …/>, hooks)      │  JS thread
│   EngineBridge interface: send(envelopeText) / onMessage(envelopeText)       │
│   ├─ WebEngineBridge   → WebView postMessage (engine-web, v1)                │
│   └─ NativeEngineBridge → DioramaEngineModule (JSI)                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Fabric + JSI                                                                 │
│   DioramaNativeView (Fabric component, props: engineId, style)               │
│   DioramaEngineModule (C++ TurboModule: postMessage / postMessages /         │
│                        postEnvelope / postBuffer / setEventHandler)          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Platform wrappers (thin)                                                     │
│   iOS: Obj-C++ view host (MTKView, CADisplayLink, gestures, CLLocation)      │
│   Android: Kotlin view host (TextureView, Choreographer, gestures, Location) │
│   Both: MessageSink impl → CallInvoker::invokeAsync, platform services       │
├──────────────────────────────────────────────────────────────────────────────┤
│ C++ core  (cpp/)                                                             │
│   Engine ─ Dispatcher (decode = decodeCommand, routing, SubscriptionRegistry) │
│   WorldStore · Projection · ThemeResolver · LabelSystem · CameraController   │
│   CharacterSystem · TravelPlanner · DropSystem · GeofenceSystem              │
├──────────────────────────────────────────────────────────────────────────────┤
│ MapLibre Native (patched) + Diorama layer                                    │
│   mbgl::Map / style / vector tiles / PMTiles / labels of the base map        │
│   DioramaLayer: extrusion+facades+roofs, instanced drops, skinned glTF,      │
│                 holo labels, post-grade — drawn in MapLibre's render pass    │
├──────────────────────────────────────────────────────────────────────────────┤
│ GPU backends: Metal (iOS) · Vulkan (Android, API 24+ where supported) · GL ES 3 fallback │
└──────────────────────────────────────────────────────────────────────────────┘
```

The TS side uses the same envelopes and codec for both engines. The native bridge only swaps the
transport: `NativeEngineBridge.send(text)` calls `postMessage(engineId, text)`, and events arrive as the
same `{"v":1,"seq":N,"kind":"evt","msg":…}` text that `decodeEvent` already accepts. The C++ output is
verified with the TypeScript `decodeEvent` itself [V: `scripts/verify-emitted-events.mjs`].

## 3. Threading model

| Thread | Owner | Runs | Must never |
| --- | --- | --- | --- |
| **JS thread** | React Native | TS API, `EngineBridge`, JSI host functions (`postMessage` etc.) | Wait on the core. Host functions only copy or retain the input and enqueue it. |
| **Main / UI thread** | OS | Fabric mount, view layout, gesture recognisers, location callbacks, native accessibility elements | Decode messages or touch core state directly. It posts to the core queue. |
| **Core thread** (one per engine) | `diorama::Engine` | Command queue drain, `Dispatcher`, all simulation systems, SubscriptionRegistry, event batching, and the MapLibre `mbgl::Map` API calls (camera, sources) | Block on I/O. Loads go to workers. |
| **Render thread** | MapLibre render loop [U: MapLibre iOS drives rendering from the main run loop; Android uses a dedicated render thread; confirm per backend in M1] | MapLibre render pass plus `DioramaLayer` draw | Read mutable simulation state. It reads an immutable **frame snapshot**. |
| **Worker pool** (2–4 threads) | Core | Tile parsing (MapLibre's own workers), glTF/cgltf decode, texture transcoding, world JSON parse for large `init` payloads, A* route planning | Emit events directly. Results return through the core queue. |

**Queues**

1. **Command queue (JS/main → core).** A multi-producer single-consumer queue of `CommandItem { variant<std::string, json::Value, SharedBuffer> }`.
   The JS thread pushes. The core thread drains it at the start of each tick, in arrival order. The order is
   total per engine, which matches the web engine's single `message` event loop.
2. **Frame snapshot (core → render).** A triple buffer: the core writes `FrameSnapshot`, which holds
   camera matrices, character poses, drop instances, label instances, and the building style table version.
   The render thread swaps in the newest complete snapshot without locking. One frame of latency is
   acceptable and is the same as engine-web's `requestAnimationFrame` model.
3. **Event queue (core → JS).** Events emitted during a tick are encoded immediately (they keep their `seq`
   order) and appended to a per-tick vector. At the end of the tick, one `CallInvoker::invokeAsync` delivers the
   whole batch to the JS handler, which dispatches each envelope in order. `response` events share the queue,
   so responses are ordered with respect to other events.
4. **Platform input (main → core).** Gestures, taps, location fixes and viewport changes are posted as
   internal items on the command queue. They are never protocol envelopes.

The skeleton `CoreEngine` serialises calls with a mutex and dispatches synchronously
[V: `cpp/src/Engine.cpp`]. The queue above replaces the mutex in M1 without changing the `Engine` interface.

**Lifecycle.**
1. Fabric mount creates the engine.
2. The view registers it in `DioramaEngineRegistry`.
3. `start()` emits `ready`.
4. The host sends `init`.

On unmount: `shutdown()` stops queue draining, cancels workers, and releases MapLibre on the render
thread. Events that are still pending are dropped, because the JS handler is gone.

## 4. Message path

### 4.1 JSI surface (`DioramaEngineModule`, C++ TurboModule shared by both platforms)

| Host function | Input | Core entry | Use |
| --- | --- | --- | --- |
| `postMessage(engineId, envelope: string)` | `encodeCommand` output | `Engine::postMessage(std::string_view)` → `decodeCommand` | Default path. It is byte-compatible with the WebView transport, so the TS bridge is identical. |
| `postMessages(engineId, envelopes: string[])` | Batch of envelope strings | `Engine::postMessages` | Batching (§4.3). |
| `postEnvelope(engineId, envelope: object)` | A plain JS object | `jsi::Object` → `json::Value` walk (no JSON text) → `decodeCommandValue` | Avoids `JSON.stringify` in JS plus a re-parse in C++ for chatty commands (`pushLocation`, `setCamera`). Validation is the same as `decodeCommand` after `JSON.parse` [V: `decode_tests.cpp` checks that the value path agrees with the text path for every fixture]. |
| `postBuffer(engineId, data: ArrayBuffer)` | UTF-8 envelope JSON in an ArrayBuffer | Parsed in place from a `jsi::MutableBuffer` kept alive by `shared_ptr` until the core thread consumes it | **Zero-copy** option for bulk payloads (`init` with inline `WorldData`, large `setDropLayer`). The JS side produces the buffer with `TextEncoder.encodeInto` into a pooled `ArrayBuffer`. |
| `setEventHandler(engineId, fn: (envelopes: string[]) => void)` | JS function | Stored as a `jsi::Function` and invoked on the JS thread only | Event delivery (§3, queue 3). |

The `jsi::Object` → `json::Value` walk must reproduce what `JSON.parse(JSON.stringify(obj))` would yield:
- drop `undefined` and function properties;
- map non-finite numbers to `null` inside arrays and drop them as property values, the same as `JSON.stringify`;
- keep own enumerable string keys in JS order.

Hosts should keep using `postMessage` whenever these edge cases matter.

### 4.2 Decode and validation

Every path ends in `protocol::decodeCommand*` [V: `cpp/src/protocol.cpp`]. Failures emit
`error {code: "invalid_message", message: <decodeCommand error>, fatal: false}` [V: `dispatcher_tests.cpp`].
Error strings match the TS codec exactly, except the V8-specific text after `$: invalid JSON: ` (§6.4).

### 4.3 Batching

- **JS → native.** `NativeEngineBridge` queues `send()` calls in a microtask and flushes them with a single
  `postMessages`. This keeps JSI crossings to about one per JS task. Commands are never merged or dropped.
  Protocol semantics (for example, partial `setCamera` merges) stay in the core.
- **Native → JS.** One `invokeAsync` per core tick carries every event of that tick. Continuous topics are
  throttled at the source by `SubscriptionRegistry` (`subscribe.throttleMs`). `overlay:positions` is emitted
  at most once per frame.

## 5. Protocol → core mapping

Statuses: **M0** is what the skeleton does today [V: `cpp/src/Dispatcher.cpp`]. **Mn** is the milestone that
implements the command (§11).

### 5.1 Commands (host → engine) — all 20 `ENGINE_COMMAND_TYPES`

<!-- protocol-commands:start -->
| Command | Kind | Core subsystem(s) | Behaviour | M0 skeleton | Full in |
| --- | --- | --- | --- | --- | --- |
| `init` | fire-and-forget | `WorldStore`, `ThemeResolver`, `LabelSystem`, `CameraController`, `CharacterSystem`, map UI | `world.kind`: `data` → `WorldStore::load`; `url` → platform HTTP then `loadJson`; `procedural` → port of engine-web's generator. The core then resolves the theme, builds labels (emits `labelsIndex`), applies `ui`, sets the camera (default framing when absent), and sets the location source. Load errors emit `error{world_load_failed, fatal: true}`. | `data` worlds load into `WorldStore` (validated + typed), other parts logged as not applied | M1 (world, camera), M2 (theme, labels, ui) |
| `setTheme` | fire-and-forget | `ThemeResolver` → style paint properties + `DioramaLayer` uniforms | `resolveTheme` precedence (§6.6); cross-fades lighting over 300 ms | ignored + warn log | M2 |
| `setLabels` | fire-and-forget | `LabelSystem::setLabels` | Rebuilds label atlases and styles | ignored + warn log | M2 |
| `setLabelContent` | fire-and-forget | `LabelSystem::setLabelContent` | Replaces host content by label id (used with `content: "custom"`) | ignored + warn log | M2 |
| `setUi` | fire-and-forget | Platform ornaments (MapLibre scale bar / attribution) + `DioramaLayer` location puck | Toggles `locationPuck`, `scaleBar`, `zoomButtons`, `attribution` | ignored + warn log | M2 |
| `setCamera` | fire-and-forget | `CameraController::setCamera` → `mbgl::Map::jumpTo/easeTo` | Merges unset fields; `distance` wins over `zoom`; `follow` locks target; `animate` duration | ignored + warn log | M1 |
| `upsertCharacters` | fire-and-forget | `CharacterSystem::upsert` | Upserts by id; async cgltf load; `error{model_load_failed}` on failure; default avatar otherwise; `model: null` drops the model (default avatar again) | ignored + warn log | M3 |
| `removeCharacters` | fire-and-forget | `CharacterSystem::remove`, `TravelPlanner::cancel` | Removes characters; running travels emit `travel:cancel` | ignored + warn log | M3 |
| `setLocationSource` | fire-and-forget | `CharacterSystem::setLocationSource` + platform location provider | `device` starts GPS (main thread), `external` waits for `pushLocation`, `simulated` runs the demo loop | ignored + warn log | M3 |
| `pushLocation` | fire-and-forget | `CharacterSystem::pushLocation` | Smoothed fix for the player (effective with `external`) | ignored + warn log | M3 |
| `travel` | fire-and-forget (answered by events) | `TravelPlanner::start` | Cancels any previous travel (`travel:cancel`), expands legs, emits `travel:start`, then `travel:progress` (subscribed) and `travel:arrive` | ignored + warn log | M3 |
| `cancelTravel` | fire-and-forget | `TravelPlanner::cancel` | Emits `travel:cancel` if a travel was running | ignored + warn log | M3 |
| `setDropLayer` | fire-and-forget | `DropSystem::setLayer` | Replaces the layer; builds instance buffers; collection radius and collectors | ignored + warn log | M3 |
| `removeDropLayer` | fire-and-forget | `DropSystem::removeLayer` | Removes the layer and its instances | ignored + warn log | M3 |
| `setGeofences` | fire-and-forget | `GeofenceSystem::setGeofences` | Replaces all geofences; membership of unchanged ids preserved | ignored + warn log | M3 |
| `setBuildingStyle` | fire-and-forget | `DioramaLayer` building style table (looked up via `WorldStore::findBuilding`) | Per-building color, roof, facade, decorations, massing, `replaceModel` (glTF), `state`; `null` clears | ignored + warn log | M2 |
| `setOverlayAnchors` | fire-and-forget | `CameraController::setOverlayAnchors` | Emits `overlay:positions` while anchors exist and the view changes | ignored + warn log | M2 |
| `subscribe` | fire-and-forget | `SubscriptionRegistry` (in `Dispatcher`) | Topic × optional id × `throttleMs`; samples `CharacterSystem` / `CameraController` / `TravelPlanner` each tick | ignored + warn log | M1 |
| `unsubscribe` | fire-and-forget | `SubscriptionRegistry` | Removes the subscription with the same topic and id | ignored + warn log | M1 |
| `request` | request → `response` | `project`, `unproject` → `CameraController`; `snapToRoad`, `route` → `TravelPlanner` | Always answered with exactly one `response` (same `requestId`); failures use `ok: false` | `response {ok: false, error.code: "unsupported"}` for every method | M1 (`project`, `unproject`), M3 (`snapToRoad`, `route`) |
<!-- protocol-commands:end -->

### 5.2 Events (engine → host) — all 16 `ENGINE_EVENT_TYPES`

<!-- protocol-events:start -->
| Event | Emitted by | Trigger | Delivery | M0 skeleton | Full in |
| --- | --- | --- | --- | --- | --- |
| `ready` | `Engine::start` → `Dispatcher::emitReady` | Engine created and sink attached | Once; `engine.kind = "native"` | emitted | M0 |
| `error` | `Dispatcher` (`invalid_message`), world loader (`world_load_failed`), `CharacterSystem`/`DropSystem` (`model_load_failed`), any subsystem (`internal`) | Decode failure, load failure, unexpected failure | Immediate (next batch) | `invalid_message`, `world_load_failed` | M0 / M3 |
| `labelsIndex` | `LabelSystem::rebuildIndex` | After every successful world load | Once per load | not emitted | M2 |
| `map:press` | `CameraController::tap` | Tap whose ray hits the ground and no building | Immediate | not emitted (tap logged) | M2 |
| `building:press` | `CameraController::tap` + `DioramaLayer` ID-buffer picking | Tap on an extruded or replaced building | Immediate | not emitted | M2 |
| `drop:collect` | `DropSystem::update` | Collector within `collectRadiusMeters`; nonce from platform CSPRNG | Immediate; drop removed first (never twice) | not emitted | M3 |
| `travel:start` | `TravelPlanner::start` | Accepted `travel` | Immediate, before any progress | not emitted | M3 |
| `travel:progress` | `SubscriptionRegistry` sampling `TravelPlanner::active` | Topic `travel:progress` subscribed | Throttled (`throttleMs`) | not emitted | M3 |
| `travel:arrive` | `TravelPlanner::update` | Destination reached | Immediate | not emitted | M3 |
| `travel:cancel` | `TravelPlanner::start` / `cancel`, `CharacterSystem::remove` | Superseded, cancelled or character removed | Immediate | not emitted | M3 |
| `geofence:enter` | `GeofenceSystem::update` | Character crosses into a geofence | Immediate | not emitted | M3 |
| `geofence:exit` | `GeofenceSystem::update` | Character leaves a geofence (or geofence removed) | Immediate | not emitted | M3 |
| `character:position` | `SubscriptionRegistry` sampling `CharacterSystem::states` | Topic subscribed (optionally per id) | Throttled | not emitted | M3 |
| `camera:change` | `SubscriptionRegistry` sampling `CameraController::state` | Topic subscribed and camera changed | Throttled | not emitted | M1 |
| `overlay:positions` | `CameraController::update` | Anchors exist and the view or anchors changed | At most once per frame | not emitted | M2 |
| `response` | `Dispatcher` (per request method handler) | Every `request` | Exactly once per `requestId` | `ok: false`, `unsupported` | M1 / M3 |
<!-- protocol-events:end -->

The table coverage is enforced by `npm test` [V: `scripts/check-design-coverage.mjs` fails when a name in
`ENGINE_COMMAND_TYPES`, `ENGINE_EVENT_TYPES` or `REQUEST_METHODS` is missing, duplicated or unknown].

## 6. Diorama layer

### 6.1 Custom layer API vs style-spec extension

| Option | Pros | Cons |
| --- | --- | --- |
| A. MapLibre custom layer API (host callback per frame) | No fork patches; upstream-supported | The legacy `CustomLayer` is GL-only [U]. The newer drawable-based custom layer for Metal/Vulkan is still evolving [U]. No style-JSON placement, no picking hooks, limited access to depth and shadow passes. |
| B. Style-spec extension: a new layer `type: "diorama"` implemented in the renderer | Participates in style ordering and zoom ranges. Shares depth with fill-extrusion and symbols. Gets theme-driven paint properties. | Requires patches to style parsing, the layer factory and the render layer. These are maintained in the queue. |
| **Decision: B, built as a thin wrapper over A's drawable machinery** | The patch registers a `diorama` layer type whose `RenderDioramaLayer` delegates drawing to `DioramaLayer` in our core, using the drawable/custom-drawable APIs. Patches stay small (factory + render-layer glue, about 4 patches) and have a chance to be upstreamed as a generic "external render layer". | Revisit in M1 if upstream's custom drawable layer already covers ordering and depth. |

The diorama layer consumes the core's `FrameSnapshot`, which holds the camera matrices shared with `mbgl::TransformState`.
World-unit geometry is placed with `Projection` (§6.7) and converted into MapLibre's mercator tile space
once per world load, never per vertex per frame.

### 6.2 Extrusion, facades and roofs

- **Footprint winding.** WorldData footprints have **positive shoelace area over the stored `[x, z]`
  values**. That is "counter-clockwise" in x/z, and it looks **clockwise on a north-up map** because z = −north
  (`packages/protocol/src/world.ts`). The core computes `shoelaceArea2` per footprint, counts negative rings
  (`WorldLoadReport::negativeAreaFootprints`), logs a warning, and the extruder reverses such rings so that
  wall normals point outward [V: `cpp/src/WorldStore.cpp`, cross-checked against a JS implementation in
  `world_store_tests.cpp`, including `tools/osm/samples/seongsu.world.json`].
- **Walls.** One quad strip per ring edge. UVs are in meters, so facade textures tile per floor. The floor height
  is `height · unitMeters · heightScale / levels` when `levels` is known, 3.2 m otherwise. The facade atlas is
  chosen by `FacadeSet` × `BuildingKind`, as ASTC 6×6 on both platforms (ETC2 fallback on GL ES).
- **Roofs.** `flat`: earcut triangulation (earcut.hpp is already vendored inside MapLibre [U]). `gable`:
  ridge along the oriented bounding box's long axis. `dome`: a cap for near-circular footprints, otherwise it
  falls back to `flat`. `flatRoofs` in the preset forces `flat`.
- **Massing** `varied`: setbacks and podiums generated deterministically from the building id hash, so
  engine-web and engine-native produce the same silhouettes.
- **Style table.** `setBuildingStyle` writes a row (color, roof, facade, decorations, massing, state) into a
  per-world texture buffer indexed by building index. A change only uploads that row, so there is no geometry
  rebuild unless roof, massing or `replaceModel` changes (then only that building's mesh chunk is rebuilt).
- **Picking.** An ID pass renders `building index + 1` into an R32UI target at ¼ resolution, only on
  frames with a pending tap.

### 6.3 Instanced drops

- One mesh per `DropType` (`model` drops use their glTF) and one draw call per type × rarity, with a
  per-instance buffer `{x, z, bobPhase, type, rarity}` (`DropInstance`).
- The bob and spin animation runs in the vertex shader from a time uniform, so the core does no per-drop work.
  Rarity controls the rim glow, sparkle particles (legendary) and beam height.
- The collection test runs on the core thread: a uniform grid (cell = 2 × max radius) for the broad phase,
  then `haversineMeters` [V: `cpp/src/Projection.cpp`] for the narrow phase. A collected drop is removed from
  the instance buffer before `drop:collect` is emitted.

### 6.4 Skinned glTF characters, and why the core has its own JSON

- **Loader: cgltf** (MIT, single header) on a worker thread. It parses GLB/glTF 2.0 and resolves buffers, and
  `asset://` URIs go through platform services. Meshes are converted to the engine vertex format
  (position, normal, uv, joints ×4, weights ×4). Textures are decoded with the platform decoder (ImageIO /
  BitmapFactory) and transcoded to ASTC off-thread when the file has none.
- **Skinning renderer.** GPU linear-blend skinning: a joint palette of ≤ 64 joints per character in a
  uniform buffer, and ≤ 4 influences per vertex. An animation state machine (`idle`, `walk`, `run`,
  `ride`, `wave`, mapped through `CharacterSpec.animations`) samples channels on the core thread and writes
  the joint matrices into the frame snapshot. Cross-fades take 150 ms.
- **Why no nlohmann/json.** The core must reproduce `decodeCommand` byte for byte. That needs JS semantics
  nlohmann does not have:
  - every number is a double, and `1e400` parses to `Infinity`;
  - own-property key order puts integer keys first;
  - on duplicate keys the last value wins but the first position is kept;
  - `JSON.stringify`/`String(number)` formatting is used inside error messages;
  - lone surrogates must round-trip.

  `cpp/src/json.cpp` implements exactly that [V: `json_tests.cpp` against `json-format.json`; 6,796 command
  and 2,538 event decode cases pass]. Known, documented differences from V8:
  1. The text after `$: invalid JSON: ` is the core's own message (the tests only require the prefix).
  2. Nesting deeper than 512 containers is rejected as invalid JSON (V8 accepts any depth). This is a
     stack-safety bound for JSI threads.
  3. Invalid UTF-8 bytes are passed through (JSI strings are always valid UTF-16-converted UTF-8).

### 6.5 Holo labels: native views vs GPU quads

| Criterion | Native views (UILabel / TextView per label) | GPU quads (SDF glyph + icon atlas) |
| --- | --- | --- |
| 3D styles (`holo` floating tiles, `sign` posts, `ground` painted) | Impossible to depth-test or perspective-warp | Natural: depth-tested billboards and ground decals |
| Count and perf | Layout cost per view; ~100 on screen before jank [E] | 1–3 draw calls for 1,000+ labels |
| Text shaping (Hangul, emoji) | Platform shaping for free | Needs shaping. We reuse MapLibre's glyph pipeline and HarfBuzz patch set [U] |
| Accessibility | Free | Needs mirrored accessibility elements |

**Decision.** GPU quads rendered by `DioramaLayer` for every style, which is consistent with engine-web's
three.js sprites. Accessibility is provided by a small pool (≤ 30) of invisible native accessibility elements
placed at the most prominent labels' `LabelInstance.anchor`. Host overlays (`setOverlayAnchors`) remain the
path for rich interactive native UI. Icons come from the atlas generated from the protocol's `LABEL_ICONS`.
The `holo` icon tile treatment (`auto`/`white`/`black`/`color`) is a shader branch.

### 6.6 Theme application

`ThemeResolver::resolve` implements `resolveTheme` precedence (spec field → `PRESET_DEFAULTS[base]` →
`BASE_THEME_DEFAULTS`). Built-in data is not duplicated in C++: the protocol build emits
`dist/themes/*.json` [V: `packages/protocol/package.json` `exports["./themes/*.json"]`], and the wrappers
bundle them. The resolved theme is applied in three places:

1. **MapLibre style** (base map beyond the diorama radius): the core sets paint properties `ground`, `water`,
   `park`, `road`, `plaza`, `centerLine` and `crosswalkColor` on the corresponding style layers.
2. **DioramaLayer uniforms:** hemisphere and sun light (`TIMES[timeOfDay]` × `hemiMul`/`sunMul`), fog
   near/far/color, exposure, tone mapping (`toneMapped`), `shading` (`standard` PBR-lite vs `toon` ramp),
   `edgeLines` / outline pass, facade set and palette, landmark colors, and window lights (`lights`).
3. **Post pass:** the CSS gradients (`haze`, `vignette`, cinematic `grade`) are parsed once into 256×1 ramp
   textures and composited in a single full-screen pass with `hazeOpacity` / `grade`.

A theme change interpolates numeric uniforms over 300 ms. Changes to toggles (facade, outline, massing)
rebuild only the affected geometry chunks on workers.

### 6.7 Coordinates and zoom-out game view

- World units follow `Projection` (a port of `createProjection` with identical math and verified within
  1e-6 world units [V: `projection_tests.cpp`, 35 origin × unit combinations]). The mapping to MapLibre
  mercator is computed once per world as an affine transform around the origin. Its error is below 1 cm
  across a 5 km world [E].
- `ZoomOutBehavior`:
  - `none` keeps the diorama at every zoom.
  - `mapColors` cross-fades the diorama layer's opacity to 0 between camera distance D1 and D2 (default
    zoom 14 → 13 [E]) while MapLibre's flat vector layers fade in with preset-derived colors.
  - `keepGameView` keeps the diorama. Beyond D2 buildings switch to merged low-LOD roof-only impostors, and
    characters and drops become icon sprites, so the draw calls stay within budget.

## 7. Tiles

- **Sources.** MapLibre `vector` sources over `https://…/{z}/{x}/{y}.pbf` and **PMTiles** archives
  (`pmtiles://https://…` or `pmtiles://asset://…`) [U: native PMTiles support in the pinned MapLibre
  release; if absent, a patch adds a `PMTilesFileSource` range-request resource loader].
- **Two roles.**
  1. The base map (flat, beyond the diorama).
  2. WorldData carried as vector tiles for large areas, so `init` does not ship multi-megabyte JSON. v1
     `WorldSource` has no tile kind, so this is a protocol addition (`{kind: "tiles", url, …}`) that
     engine-web must also implement before either engine exposes it (§11).
- **Vector-tile schema carrying WorldData** (MVT v2, extent 4096, zoom 12–16, geometry in lng/lat mercator;
  the core converts it to world units with `Projection`):

| Layer | Geometry | Properties | WorldData field |
| --- | --- | --- | --- |
| `diorama_roads` | LineString | `id` (string), `cls` (`arterial`/`local`/`alley`), `name`?, `bridge`? (bool) | `roads[]` |
| `diorama_buildings` | Polygon (exterior ring, positive shoelace area in world `[x, z]` after projection) | `id`, `height_m` (meters; world `height = height_m / unitMeters`), `levels`?, `kind`?, `name`? | `buildings[]` |
| `diorama_water` | Polygon | none | `water[]` |
| `diorama_parks` | Polygon | `name`? | `parks[]` |
| `diorama_pois` | Point | `id`, `name`, `cat` (`POI_CATEGORIES`) | `pois[]` |
| `diorama_stations` | Point | `id`, `name` | `stations[]` |
| `diorama_districts` | Point | `name`, `water`? | `districts[]` |

  World-level fields live in the PMTiles metadata JSON under the key `"diorama"`:
  `{version: 1, name, origin, unitMeters, bounds, plaza?, attribution[]}`. For z/x/y sources they are in
  `…/diorama.json`. Features split across tiles are deduplicated by `id`. Buildings are reassembled from the
  highest zoom that contains them.

## 8. Memory and performance budgets

Targets for a mid-range reference device (iPhone 12 / Pixel 6a class) with the Seongsu sample scaled to
20,000 buildings. All figures are **[E]** until they are measured in M4. CI perf gates are added once real
numbers exist.

| Budget | Target |
| --- | --- |
| Frame time | 16.6 ms at 60 fps (p95); core tick ≤ 2 ms; diorama encode ≤ 4 ms; MapLibre base map ≤ 5 ms |
| Native heap (engine total) | ≤ 250 MB. MapLibre tile cache 50 MB, diorama geometry ≤ 60 MB, textures ≤ 64 MB, characters ≤ 8 MB each, other |
| GPU draw calls | ≤ 150 per frame (buildings chunked by 256 m cells; drops 1 call per type × rarity; labels ≤ 3) |
| Characters | ≤ 32 skinned, ≤ 64 joints each |
| Drops | ≤ 5,000 active, ≤ 1,500 visible |
| Labels | ≤ 1,000 indexed, ≤ 300 placed per frame |
| Message decode | Typical command ≤ 0.2 ms; `init` with a 5 MB inline world ≤ 150 ms on a worker (p95) |
| Latency | JS `send` → applied ≤ 1 frame; event emitted → JS handler ≤ 1 frame |
| Cold start | View mount → `ready` ≤ 300 ms; `init` → first diorama frame ≤ 1 s (sample world) |
| Binary size | ≤ +12 MB per ABI (MapLibre + core), excluding assets |
| Battery | `device` location source ≤ 5 %/h additional drain in foreground [E] |

The skeleton's own numbers are not budget evidence. It is built with ASan/UBSan for tests
[V: `scripts/build-core.sh --tests`].

## 9. Build and packaging

- The core is built by `scripts/build-core.sh` on macOS with `xcrun clang++` (no CMake on this toolchain)
  [V]. iOS compiles the same `cpp/src` from the podspec. Android compiles it from CMake through Gradle
  `externalNativeBuild`.
- The patched MapLibre is built in CI from `patches/` into an XCFramework (Metal) and an AAR. App builds
  consume these prebuilt artifacts, so they never apply patches.
- Tests: `npm test -w @diorama/engine-native` runs these steps:
  1. export fixtures from the built protocol package;
  2. check DESIGN.md coverage;
  3. build the core plus the sanitizer test binary;
  4. run the C++ conformance suites;
  5. validate the C++-emitted events with the TS `decodeEvent`;
  6. run the patch-queue fixture test.

## 10. Patch-queue workflow

```
packages/engine-native/patches/
  UPSTREAM                      # first non-comment line = upstream ref (tag), pinned in M1
  0001-<subject>.patch          # git format-patch output, zero commit ids, no stat/signature
  0002-<subject>.patch
scripts/patch-queue/
  apply.sh   <clone> [--patches DIR] [--base REF] [--branch NAME]
  refresh.sh <clone> [--patches DIR] [--base REF]
  rebase.sh  <clone> <new-ref> [--patches DIR] [--branch NAME]
  test.sh    # throwaway upstream fixture; run by npm test
```

- **Apply.** `apply.sh ~/src/maplibre-native` checks out `diorama/patched` at `UPSTREAM` and runs
  `git am --3way patches/*.patch`. It refuses a dirty tree, an in-progress am/rebase, an unknown ref or
  an unpinned base.
- **Develop.** Commit on `diorama/patched` with one concern per commit and the subject prefix `[diorama]`.
  Mark patches meant for upstream with `Upstream-Status: pending` in the commit body.
- **Refresh.** `refresh.sh ~/src/maplibre-native` regenerates `patches/` from `UPSTREAM..HEAD`. The output is
  normalised (zero commit ids, no diffstat/signature, fixed abbreviations), so a refresh with no changes is
  byte-identical [V: `test.sh`].
- **Rebase.** `rebase.sh ~/src/maplibre-native maplibre-native-vX.Y.Z` applies the queue onto the new tag.
  On success it refreshes and re-pins `UPSTREAM`. On conflict it exits 1 with the `git am` session open and
  `patches/` untouched. After resolving, run `refresh.sh --base <new>` and pin the new ref.
- **CI.**
  1. On each PR: shallow-fetch upstream at `UPSTREAM`, run `apply.sh`, build both platform artifacts, run the
     core tests, then run `refresh.sh` and fail on `git diff --exit-code patches/` (the queue must be
     refreshed).
  2. Weekly: `rebase.sh` onto upstream's latest release tag in a scratch clone. A conflict or build failure
     opens an issue. Nothing is committed automatically.
- **Cadence and hygiene.** Rebase at least once per MapLibre Native release. Keep the queue under about 15
  patches. Fold fixups into their parent patch. Prefer upstream PRs over growing the queue.
- **Licensing.** Patches to MapLibre Native files stay under BSD-2-Clause. §12 lists NOTICE entries for when
  the code ships (the root NOTICE is not edited by this package yet).

## 11. Parity matrix and milestones

engine-web status is taken from the v1 plan: it is the shipping engine and implements the full protocol
[U: not re-verified here]. Native columns follow the milestones below.

| Capability | Protocol surface | engine-web | engine-native |
| --- | --- | --- | --- |
| Envelope codec + validation | `decodeCommand` / `encodeEvent` | v1 | **M0** (conformance-tested) |
| Projection | `createProjection` | v1 | **M0** (within 1e-6) |
| WorldData load (`data`) | `init.world` | v1 | **M0** store; render M1 |
| WorldData `url` / `procedural` | `init.world` | v1 | M1 |
| Camera + gestures | `setCamera`, `camera:change`, `project`/`unproject` | v1 | M1 |
| Subscriptions | `subscribe` / `unsubscribe` | v1 | M1 |
| Buildings: extrusion, facades, roofs, massing | `setTheme`, `setBuildingStyle` | v1 | M2 |
| Themes + time of day + cinematic | `setTheme` | v1 | M2 |
| Labels (all styles, custom content) | `setLabels`, `setLabelContent`, `labelsIndex` | v1 | M2 |
| Map UI | `setUi` | v1 | M2 |
| Presses | `map:press`, `building:press` | v1 | M2 |
| Overlay anchors | `setOverlayAnchors`, `overlay:positions` | v1 | M2 |
| Characters (glTF skinning) + location sources | `upsertCharacters`, `removeCharacters`, `setLocationSource`, `pushLocation`, `character:position` | v1 | M3 |
| Travel + routing | `travel`, `cancelTravel`, `travel:*`, `snapToRoad`, `route` | v1 | M3 |
| Drops | `setDropLayer`, `removeDropLayer`, `drop:collect` | v1 | M3 |
| Geofences | `setGeofences`, `geofence:*` | v1 | M3 |
| Zoom-out game view | `theme.zoomOut` | v1 | M4 |
| PMTiles / tile-backed WorldData | (protocol addition) | planned | planned (same release as web) |

**Milestones**

- **M0 — foundation (this change).** Design, interfaces, the JS-exact JSON codec, `Projection`,
  `WorldStore`, the skeleton dispatcher (`unsupported` responses, warn-logged fire-and-forget), fixture
  conformance tests, patch-queue tooling.
- **M1 — map on screen.**
  - Pin `UPSTREAM`.
  - First patches: the `diorama` layer type and PMTiles support if needed.
  - CI artifacts (XCFramework/AAR).
  - `DioramaNativeView` + `DioramaEngineModule` on both platforms.
  - Command queue, frame snapshot, event batching.
  - `init` with data/url/procedural worlds rendering the flat map.
  - Camera + gestures, `project`/`unproject`, SubscriptionRegistry, `camera:change`.
- **M2 — diorama look.** Extrusion, facades, roofs, massing, style table + picking, `ThemeResolver`, the
  label system (GPU quads + accessibility pool), `labelsIndex`, map UI, presses, overlay anchors.
- **M3 — game systems.** cgltf skinning, `CharacterSystem` and location sources, `TravelPlanner` (A*,
  subway expansion), drops, geofences, all remaining events.
- **M4 — parity and performance.**
  - Zoom-out game view.
  - Device perf and memory measured against §8.
  - Parity matrix all green using the RN example app, with the web and native engines side by side.
  - `engine="native"` beta.

## 12. Third-party components (NOTICE list for this package)

The root `NOTICE` is intentionally not modified by M0. Add these entries when the code ships:

| Component | License | Used for | Status |
| --- | --- | --- | --- |
| MapLibre Native | BSD-2-Clause | Base renderer (patch queue) | planned (M1) |
| cgltf | MIT | glTF 2.0 / GLB loading | planned (M3) |
| earcut.hpp | ISC | Roof and polygon triangulation (via MapLibre) | planned (M2) [U: bundled by MapLibre] |
| nlohmann/json | MIT | — | **not used** (self-written JS-semantics parser, §6.4) |

## 13. Skeleton behaviour summary (M0)

| Input | Output |
| --- | --- |
| Engine `start()` | `ready {engine: {name: "diorama-native", version: "0.0.0", kind: "native"}}` |
| Envelope failing `decodeCommand` rules | `error {code: "invalid_message", message: <exact decodeCommand error>, fatal: false}` |
| `request` (any method) | `response {requestId, ok: false, error: {code: "unsupported", message}}` |
| `init` with `world.kind = "data"` | `WorldStore` loaded (plus warn logs for semantic issues); remaining init parts warn-logged |
| Any other command | Ignored with a `LogLevel::Warn` log (the protocol has no warning event) |
| Outgoing events (debug/tests) | Validated with `validateEngineEvent`; invalid ones dropped and logged |
