# `@maprama/engine-native` — native engine v2 design

Status: **M2c (diorama look, part 2: custom building layer)** on top of M2a and M1 (map on screen). This
package contains:

- this design;
- the C++ core (`cpp/`): protocol codec, `WorldStore`, `Projection`, `ThemeResolver`, the dispatcher, and the
  map session (world → MapLibre style with 3D buildings in theme colours, camera, `camera:change`,
  `project`/`unproject`, `setTheme`, `setBuildingStyle`, presses, map UI, overlay anchors) behind the
  `MapAdapter` interface (§2.1), the M2c building meshes (roofs, facade windows and details, outlines,
  captured flag; `BuildingMesh`, §6.2), with their conformance and behaviour tests;
- the React Native library: codegen specs, the `native` engine host (`src/`), the iOS Fabric view +
  TurboModule + Metal custom layer (`ios/`, `MapramaEngineNative.podspec`) and the Android ones with a GL ES 3
  custom layer (`android/`), all on the official prebuilt MapLibre Native SDKs (no fork, §6.1);
- the MapLibre Native patch-queue tooling (kept for the fork fallback, §10).

v1 ships `@maprama/engine-web`. The native engine speaks exactly the same `@maprama/protocol` messages, so
the React Native package switches engines with a prop (`engine="web" | "native"`, after
`import '@maprama/engine-native'`) without API changes.

Evidence labels used below: **[V]** verified in this repository (a command or file is named),
**[E]** an estimate or target to be validated, **[U]** an unverified assumption about third-party code,
to be confirmed in milestone M1.

---

## 1. Constraints and decisions

| Topic | Decision |
| --- | --- |
| React Native | New Architecture only: a Fabric view plus a TurboModule over JSI. RN 0.76+, iOS 15.1+, Android API 24+. No bridge fallback. |
| Renderer base (M1) | **Official prebuilt MapLibre Native SDKs** (user decision, M1): iOS `MapLibre` pod (`~> 6.30`: ios-v6.31.0 is on GitHub/SPM only, CocoaPods trunk tops out at 6.30.0) and Android `org.maplibre.gl:android-sdk:13.6.1`. maplibre-native is **not** cloned or built from source for M1 (~5 GB). These SDKs expose Obj-C / Java APIs, not the `mbgl` C++ headers, so the core drives the map through the platform-implemented `MapAdapter` (§2.1). |
| Renderer base (M2) | **Still the official SDKs** (decided after M1). M2 ships in three steps on them: **M2a** style layers (fill-extrusion buildings, themes + time of day, building styles, presses, map UI, overlay anchors), **M2b** labels (a native view pool + `labelsIndex`) and `procedural` worlds, **M2c** a custom render layer for roofs / facades / outlines / the captured look on iOS `MLNCustomStyleLayer` (Metal) and Android `CustomLayerHost` (GL ES 3 on the `android-sdk-opengl` artifact), done without a fork (§6.1). Forking **MapLibre Native** (BSD-2-Clause) as a **patch queue** (`patches/*.patch`, §10) with an `mbgl::Map`-backed `MapAdapter` stays a fallback only (for example if a later milestone needs ID-buffer picking or a style-spec layer type). |
| Code sharing | One **C++ shared core** (protocol, simulation, maprama layer). Obj-C++ (iOS) and Kotlin/JNI (Android) wrappers stay thin (`ios/README.md`, `android/README.md`). |
| Contract | `@maprama/protocol` is the single source of truth. The core decodes envelopes **identically** to `decodeCommand`, and the conformance tests prove it against fixtures exported from the TS package on every `npm test` [V: `scripts/export-fixtures.mjs`, `cpp/tests/decode_tests.cpp`]. |
| Engine selection | The RN prop `engine="web" \| "native"`. Parity is tracked in §11. |
| C++ standard | C++17 for the core (it compiles inside RN's C++20 toolchains). Floating-point `std::to_chars` is avoided because it is unavailable on iOS < 16.3 [E]. The core uses `snprintf`/`strtod` shortest round-trip instead (`cpp/src/json.cpp`). |
| JSON | A small self-written parser with JavaScript semantics (`cpp/include/maprama/json.hpp`). §6.4 explains why this beat vendoring nlohmann/json. |

## 2. Layer stack

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TS API  (@maprama/react-native: <MapramaView engine="native" …/>, hooks)      │  JS thread
│   EngineBridge interface: send(envelopeText) / onMessage(envelopeText)       │
│   ├─ WebEngineBridge   → WebView postMessage (engine-web, v1)                │
│   └─ NativeEngineBridge → MapramaEngineModule (JSI)                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Fabric + JSI                                                                 │
│   MapramaNativeView (Fabric component, props: engineId, style)               │
│   MapramaEngineModule (C++ TurboModule: postMessage / postMessages /         │
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
│ MapLibre Native (patched) + Maprama layer                                    │
│   mbgl::Map / style / vector tiles / PMTiles / labels of the base map        │
│   MapramaLayer: extrusion+facades+roofs, instanced drops, skinned glTF,      │
│                 holo labels, post-grade — drawn in MapLibre's render pass    │
├──────────────────────────────────────────────────────────────────────────────┤
│ GPU backends: Metal (iOS) · Vulkan (Android, API 24+ where supported) · GL ES 3 fallback │
└──────────────────────────────────────────────────────────────────────────────┘
```

The TS side uses the same envelopes and codec for both engines. The native bridge only swaps the
transport: `NativeEngineBridge.send(text)` calls `postMessage(engineId, text)`, and events arrive as the
same `{"v":1,"seq":N,"kind":"evt","msg":…}` text that `decodeEvent` already accepts. The C++ output is
verified with the TypeScript `decodeEvent` itself [V: `scripts/verify-emitted-events.mjs`].

The diagram is the target (M2+). At M1 the bottom two boxes are the official prebuilt MapLibre SDKs,
driven through the adapter below, and the wrappers host `MLNMapView` / `MapView` instead of an MTKView /
TextureView of their own.

### 2.1 Platform map adapter (`MapAdapter`, M1 + M2a)

The official SDKs expose Obj-C (`MLNMapView`) and Java/Kotlin (`MapView`, `MapLibreMap`) APIs, not the
`mbgl` C++ headers, so the core cannot own an `mbgl::Map`. Instead the core talks to a small
platform-implemented interface [V: `cpp/include/maprama/MapAdapter.hpp`]:

| `MapAdapter` call (core → platform) | iOS (`ios/MapramaNativeView.mm`) | Android (`MapramaNativeView.kt` + `maprama_jni.cpp`) | Reply (platform → core) |
| --- | --- | --- | --- |
| `setStyleJson(json)` | `MLNMapView.styleJSON` | `MapLibreMap.setStyle(Style.Builder().fromJson(json))` | — |
| `setPaintProperties(changes)` (M2a) | KVC on `MLNStyleLayer` (`fill-extrusion-color` → `fillExtrusionColor`) with an `NSExpression` (`+expressionWithMLNJSONObject:`; `UIColor` for constant colours), queued until `didFinishLoadingStyle` | `Layer.setProperties(PaintPropertyValue(name, value))` (`Expression.Converter` for expressions) inside `getStyle {}` of the current style generation | — |
| `setLight(light)` (M2a) | `MLNStyle.light` (`MLNLight`: anchor map, `MLNSphericalPosition`, colour, intensity) | `style.light` (`setAnchor`, `Position`, `setColor`, `setIntensity`) | — |
| `setUi(state)` (M2a) | own scale bar / zoom buttons / attribution label + `logoView`, `attributionButton`, `compassView` | own views in the `FrameLayout` + `UiSettings` logo / attribution / compass | zoom buttons → `Engine::zoomButton(in)` |
| `setBuildingLayer(data)` (M2c) | `MapramaBuildingLayer` (`MLNCustomStyleLayer` subclass, Metal) inserted below `buildings` after every style load; `setData:` + `setNeedsDisplay` | `BuildingLayerState` (shared with the render thread) + `CustomLayer("maprama-buildings-3d", BuildingLayerHost*)` added below `buildings` (`MapramaJni.createBuildingLayerHost`), `triggerRepaint` | — |
| `setCameraLimits(minZoom, maxZoom, minPitch, maxPitch)` | `minimum/maximumZoomLevel`, `minimum/maximumPitch` | `setMin/MaxZoomPreference`, `setMin/MaxPitchPreference` | — |
| `moveCamera(pose, durationMs)` | `setCamera:(animated:\|withDuration:)` (altitude via `MLNAltitudeForZoomLevel`) | `moveCamera` / `easeCamera(CameraUpdateFactory.newCameraPosition)` | camera reports below |
| `project(token, lngLat)` | `convertCoordinate:toPointToView:` | `projection.toScreenLocation` (px → dp) | `Engine::onProjected(token, x, y)` |
| `projectPoints(token, lngLats)` (M2a) | `convertCoordinate:toPointToView:` per anchor | `projection.toScreenLocation` per anchor | `Engine::onPointsProjected(token, points)` |
| `unproject(token, x, y)` | `convertPoint:toCoordinateFromView:` | `projection.fromScreenLocation` (dp → px) | `Engine::onUnprojected(token, lngLat?)` |
| `queryBuilding(token, x, y)` (M2a) | `visibleFeaturesAtPoint:inStyleLayersWithIdentifiers:{buildings}` + `convertPoint:toCoordinateFromView:` | `queryRenderedFeatures(PointF, "buildings")` + `fromScreenLocation` | `Engine::onBuildingQueried(token, id?, ground?)` |
| `fetchText(token, url)` | `NSURLSession` | `HttpURLConnection` on a worker thread | `Engine::onTextFetched(token, ok, body \| message)` |
| `scheduleFrame(delayMs)` | `dispatch_after` on the main queue | `Handler.postDelayed` on the main looper | `Engine::frame(t)` |
| (camera observer) | `mapViewRegionIsChanging:` / `regionDidChangeAnimated:` | `OnCameraMoveListener` / `OnCameraIdleListener` | `Engine::onCameraChanged(pose)` |
| (tap observer, M2a) | `UITapGestureRecognizer` on the map (waits for the double-tap zoom, recognises alongside the SDK's own; not on the zoom buttons) | `addOnMapClickListener` | `Engine::tap(x, y)` → `queryBuilding` |

- **Style.** `init` converts the `WorldData` into one MapLibre style JSON (v8) with inline GeoJSON
  sources in lng/lat (through `Projection`): background, world area, parks, water, roads as lines by class
  (widths in meters from engine-web's `ROAD_W`, exact at every zoom through exponential-base-2
  interpolation), POI and station circles and the 3D buildings (below), in the resolved theme's colours and
  light [V: `cpp/src/WorldStyle.cpp`, `map_session_tests.cpp`, `m2a_tests.cpp`]. The sources are built once
  per world; the layers are rebuilt from the theme and the building overrides, and the session sends only
  the paint properties that changed. Both platforms render the same string (an `mbgl` adapter could
  `loadJSON` it unchanged).
- **3D buildings (M2a).** One `fill-extrusion` layer on the buildings source, drawn last so it occludes
  roads, POIs and stations: `fill-extrusion-height = height · heightScale` with
  `height = max(0.2, WorldData height) · unitMeters` (engine-web's rule; `levels` only drives facade floors,
  M2c), base 0 (WorldData v1 has no base height), vertical gradient on. Degenerate footprints
  (area < 0.01 units², not rendered by engine-web either) are skipped. There is no flat footprint layer:
  the extrusions read well over the whole distance range (14–150 world units).
- **Theme → style (M2a).** `ThemeResolver` (§6.6) → `MapLook` [V: `cpp/src/MapLook.cpp`,
  `map_look_colors_light_and_scale_bar`]: engine-web's static-world colours (textured presets use the
  texture tints: grass `#86A56E`, asphalt `#55585E`, pads `#C4C1BA`), road casings = pads (sidewalks),
  alleys = asphalt/pad mix, arterial centre lines when `roads.laneMarkings`, water / parks from the preset,
  background = the time-of-day fog (engine-web's clear colour). Building colours are
  `palette[hashId(id) % 6]` (feature property `ci`), or the urban colour schemes (`si`) with urban facade
  details. Time of day becomes the style `light` (sun direction → spherical position, 40 % of the sun
  colour mixed into white, intensity from `sunI · sunMul`) plus a per-channel tint of every other colour:
  75 % of the ratio (hemisphere sky + elevation-weighted sun) × exposure relative to `TIMES.day`, so day
  shows the preset's exact colours and dusk / night darken the map (both factors calibrated on device:
  the full values turned the toy palette at dusk deep red). `setTheme` sends only the changed paint properties and the light (no style
  reload, no 300 ms cross-fade yet) plus the rebuilt custom building layer (M2c: facades, facade details and
  outlines). Options that are still not drawn (`massing: "varied"`, cinematic grading, `zoomOut`) are
  accepted and warn-logged once each; `edgeLines` is carried by engine-web's render params but not drawn by
  engine-web either, so it is not drawn here.
- **Building styles (M2a).** Data-driven paint, not feature-state (the iOS SDK has no public feature-state
  API): `fill-extrusion-color` = `match` on the `id` property over the theme expression, one branch per id
  (the iOS SDK round-trips values through `NSExpression`, which does not keep label arrays reliably).
  `state: "captured"` mixes 35 % of engine-web's glow `#FFD36E` into the colour and shows an accent ring
  (`buildings-captured` line layer, `line-opacity` match). `null` clears, a new world clears every
  override. `roof` and `facade` go to the custom building layer (M2c, below); `decorations` / `massing` /
  `replaceModel` are warn-logged once.
- **Custom building layer (M2c).** `buildBuildingLayer` (`cpp/src/BuildingMesh.cpp`) turns the world, the
  resolved theme and the overrides into one immutable `BuildingLayerData` (indexed triangles, outline quads,
  light, window lights), rebuilt on world load / `setTheme` / `setBuildingStyle` (≈ 10 ms for Seongsu's 428
  buildings, sanitizer build) and sent only when its content changed. Vertices are placed through
  `Projection` and web mercator exactly, relative to the world origin in "local units" (mercator ×
  2π·6378137·cos(lat₀) ≈ meters), z in meters like `fill-extrusion-height`; `buildingLayerMatrix` multiplies
  MapLibre's `nearClippedProjectionMatrix` (the matrix fill-extrusions use) with the local → world-pixel
  transform in double. Both platforms draw it with a small shader pair (MSL / GLSL ES 3.00, same math):
  MapLibre's own extrusion lighting (`fill_extrusion.vertex.glsl`: light position from
  `Position::calculateCartesian`, vertical gradient) so roofs and facades match the walls, engine-web's
  window layouts per facade set with lit windows at night, and screen-space outline quads. The layer sits
  directly **below** `buildings`: both write and test depth, so draw order only breaks ties, and on MapLibre
  GL the layer's sublayer depth is what reveals the extrusions' 3D depth range (below). Presses still use the
  extrusion's rendered-feature query (roof parts above the walls are not pickable).
  Unknown ids emit `error {unknown_building, "setBuildingStyle: unknown building \"<id>\""}` and a missing
  world `error {not_ready}` (engine-web's codes and messages, `fatal: false`).
- **Presses (M2a).** Platform single taps → `Engine::tap` → `MapAdapter::queryBuilding` (rendered-feature
  query of the extrusion layer, which is 3D-aware) → `building:press {buildingId, coordinate}` for a
  rendered building, or `map:press {coordinate}` for the ground. The SDK query has no hit point, so the
  building coordinate is the ground point under the tap when it lies on the footprint, else the centroid.
- **Overlay anchors (M2a).** Camera reports, viewport changes and anchor changes request one
  `projectPoints` batch, at most one per 16 ms frame and one in flight (a reply for a stale anchor set is
  dropped and re-requested). `overlay:positions` is emitted when the set changed or a position moved by
  ≥ 0.25 dp or changed visibility (engine-web's `OverlayTracker`); `visible` = inside the viewport.
- **Map UI (M2a).** The core resolves `MapUiSpec` into `MapUiState` [V: `m2a_map_ui_state`]: scale bar
  (engine-web's `scaleBarFor` at the target's ground resolution), zoom buttons (±1.45× distance over
  250 ms, clamped, through `Engine::zoomButton`) with the MapLibre compass, and the visible attribution
  text (the world's `attribution` lines) with the MapLibre logo and attribution button. `setUi` replaces
  the whole spec (absent = off, like engine-web); only changes reach the platform. `locationPuck` is
  warn-logged once (the puck needs the player, M3).
- **Camera model.** `MapSession` keeps the protocol `CameraState` and merges `setCamera` into it (§5.1).
  Poses sent to the adapter are MapLibre zoom levels; the conversion matches the ground scale at the target
  to engine-web's 40° reference frustum, so both engines frame the same area for the same `CameraState`
  (the protocol `zoom` z is MapLibre zoom z − 1) [V: `cpp/include/maprama/CameraMath.hpp`,
  `camera_math_conversions`]. The distance limits are engine-web's (14–150 world units) and are pushed as
  MapLibre zoom limits for gestures; pitch is limited to 0–60°.
- **Replies are asynchronous.** The core calls the adapter with its lock held; the adapter posts to the
  main thread and answers through the Engine's `on*` methods, which take the lock again. Pending
  `project`/`unproject` requests are answered with `ok: false` (`not_ready`) when the view detaches.
- **Fork fallback.** Not needed for M2c (§1, §6.1): an adapter implemented on `mbgl::Map` (patched fork) would
  replace both platform adapters; `MapSession`, the style builder, `BuildingMesh` and the tests stay.

## 3. Threading model

| Thread | Owner | Runs | Must never |
| --- | --- | --- | --- |
| **JS thread** | React Native | TS API, `EngineBridge`, JSI host functions (`postMessage` etc.) | Wait on the core. Host functions only copy or retain the input and enqueue it. |
| **Main / UI thread** | OS | Fabric mount, view layout, gesture recognisers, location callbacks, native accessibility elements | Decode messages or touch core state directly. It posts to the core queue. |
| **Core thread** (one per engine) | `maprama::Engine` | Command queue drain, `Dispatcher`, all simulation systems, SubscriptionRegistry, event batching, and the MapLibre `mbgl::Map` API calls (camera, sources) | Block on I/O. Loads go to workers. |
| **Render thread** | MapLibre render loop [U: MapLibre iOS drives rendering from the main run loop; Android uses a dedicated render thread; confirm per backend in M1] | MapLibre render pass plus `MapramaLayer` draw | Read mutable simulation state. It reads an immutable **frame snapshot**. |
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

**M1 simplification.** `CoreEngine` still serialises every call with one mutex per engine and dispatches
synchronously [V: `cpp/src/Engine.cpp`]; there is no core thread, frame snapshot or per-tick event batch
yet. Commands run on the thread that delivers them (the TurboModule method queue on iOS, the JS thread on
Android); platform callbacks (camera reports, adapter replies, scheduled frames) run on the main thread
and take the same lock. This is safe because the `MapAdapter` never calls back synchronously (§2.1), and
it is cheap enough for M1 because MapLibre owns rendering: the core only merges camera state, answers
requests and throttles `camera:change` (flushed by `MapAdapter::scheduleFrame`, not by a render loop).
Events are emitted one envelope at a time through the TurboModule event emitter (§4.1). The queue above
replaces the mutex when the core gains per-frame work (M2/M3) without changing the `Engine` interface.

**Lifecycle.**
1. Fabric mount creates the engine.
2. The view registers it in `MapramaEngineRegistry`.
3. `start()` emits `ready`.
4. The host sends `init`.

On unmount: `shutdown()` stops queue draining, cancels workers, and releases MapLibre on the render
thread. Events that are still pending are dropped, because the JS handler is gone.

## 4. Message path

### 4.1 JSI surface (`MapramaEngineModule`, C++ TurboModule shared by both platforms)

| Host function | Input | Core entry | Use |
| --- | --- | --- | --- |
| `postMessage(engineId, envelope: string)` | `encodeCommand` output | `Engine::postMessage(std::string_view)` → `decodeCommand` | Default path. It is byte-compatible with the WebView transport, so the TS bridge is identical. |
| `postMessages(engineId, envelopes: string[])` | Batch of envelope strings | `Engine::postMessages` | Batching (§4.3). |
| `postEnvelope(engineId, envelope: object)` | A plain JS object | `jsi::Object` → `json::Value` walk (no JSON text) → `decodeCommandValue` | Avoids `JSON.stringify` in JS plus a re-parse in C++ for chatty commands (`pushLocation`, `setCamera`). Validation is the same as `decodeCommand` after `JSON.parse` [V: `decode_tests.cpp` checks that the value path agrees with the text path for every fixture]. |
| `postBuffer(engineId, data: ArrayBuffer)` | UTF-8 envelope JSON in an ArrayBuffer | Parsed in place from a `jsi::MutableBuffer` kept alive by `shared_ptr` until the core thread consumes it | **Zero-copy** option for bulk payloads (`init` with inline `WorldData`, large `setDropLayer`). The JS side produces the buffer with `TextEncoder.encodeInto` into a pooled `ArrayBuffer`. |
| `setEventHandler(engineId, fn: (envelopes: string[]) => void)` | JS function | Stored as a `jsi::Function` and invoked on the JS thread only | Event delivery (§3, queue 3). |

**M1 deviation (implemented transport).** M1 ships a codegen **Obj-C / Java TurboModule** instead of the
pure C++ JSI module above [V: `src/specs/NativeMapramaEngineModule.ts`]:

| M1 member | Replaces | Notes |
| --- | --- | --- |
| `postMessage(engineId, envelope: string)` | same | Looks the engine up in the shared C++ `EngineRegistry` and calls `Engine::postMessage`. |
| `postMessages(engineId, envelopes: string[])` | same | `NativeEngineHost` batches the `send()` calls of one JS task in a microtask (§4.3). |
| `onEngineEvent: EventEmitter<{engineId, envelope}>` | `setEventHandler` | Codegen TurboModule `EventEmitter` (RN 0.80+); one emission per envelope, filtered by `engineId` in JS. Events emitted before the JS object exists are buffered natively (512) and in JS (256 per engine) until the host attaches. |
| — | `postEnvelope`, `postBuffer` | Not in M1. The M1 core entry points (`Engine::postEnvelope`) exist; the JSI bindings come with the C++ TurboModule. |

The host side is `NativeEngineHost` (`src/NativeEngineHost.tsx`): it renders `MapramaNativeView` with a
fresh `engineId` and wraps the transport in `createMessageChannelHost('native', …)` from
`@maprama/react-native`, so encoding, decoding and validation are byte-identical to the WebView host.
`import '@maprama/engine-native'` calls `registerEngineHost('native', NativeEngineHost)`.

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

Statuses: **Current (M1)** is what the core does today [V: `cpp/src/Dispatcher.cpp`, `cpp/src/MapSession.cpp`,
`cpp/tests/map_session_tests.cpp`]. **Mn** is the milestone that implements the command fully (§11).

### 5.1 Commands (host → engine) — all 20 `ENGINE_COMMAND_TYPES`

<!-- protocol-commands:start -->
| Command | Kind | Core subsystem(s) | Behaviour | Current (M1) | Full in |
| --- | --- | --- | --- | --- | --- |
| `init` | fire-and-forget | `WorldStore`, `ThemeResolver`, `LabelSystem`, `CameraController`, `CharacterSystem`, map UI | `world.kind`: `data` → `WorldStore::load`; `url` → platform HTTP then `loadJson`; `procedural` → port of engine-web's generator. The core then resolves the theme, builds labels (emits `labelsIndex`), applies `ui`, sets the camera (default framing when absent), and sets the location source. Load errors emit `error{world_load_failed, fatal: true}`. | `data` and `url` (fetched by the adapter) worlds load into `WorldStore` and become the map style (§2.1); default framing (engine-web `DEFAULT_ORBIT` at the plaza) then `init.camera`; `procedural` worlds are generated by the C++ port of engine-web's generators, converted to WorldData and loaded the same way, framed at the generator's start point (M2b, §6.8); `theme` and `ui` applied at once (M2a; a `setTheme` sent during a url load wins, as in engine-web); labels and a non-`external` locationSource warn-logged once | M1 (world, camera), M2a (theme, ui), M2b (labels, procedural), M3 (location) |
| `setTheme` | fire-and-forget | `ThemeResolver` → style paint properties + light (M2a), custom building layer (M2c) | `resolveTheme` precedence (§6.6); cross-fades lighting over 300 ms | resolved by the C++ `ThemeResolver`; changed paint properties + light sent to the map (§2.1); facades, facade details, outlines and window lights rebuilt in the custom building layer (M2c); varied massing / cinematic grading / zoomOut warn-logged once; no cross-fade | M2a (colours, light), M2c (facades, details, outlines), M4 (grade, massing, zoomOut) |
| `setLabels` | fire-and-forget | `LabelSystem::setLabels` | Rebuilds label atlases and styles | ignored + warn log | M2b |
| `setLabelContent` | fire-and-forget | `LabelSystem::setLabelContent` | Replaces host content by label id (used with `content: "custom"`) | ignored + warn log | M2b |
| `setUi` | fire-and-forget | `MapSession` → `MapUiState` → platform ornaments; location puck (M3) | Toggles `locationPuck`, `scaleBar`, `zoomButtons`, `attribution` | replaces the spec; scale bar, zoom buttons (+ compass) and attribution text (+ MapLibre logo / attribution button) drawn from core-computed values (§2.1); `locationPuck` warn-logged once | M2a (puck M3) |
| `setCamera` | fire-and-forget | `CameraController::setCamera` → `mbgl::Map::jumpTo/easeTo` | Merges unset fields; `distance` wins over `zoom`; `follow` locks target; `animate` duration | `MapSession::setCamera`: merge, distance clamped to 14–150 world units, pitch to 0–60°, `animate` (`true` = 600 ms); `follow: "<id>"` warn-logged (needs characters), other fields still applied | M1 (`follow` M3) |
| `upsertCharacters` | fire-and-forget | `CharacterSystem::upsert` | Upserts by id, merging into the existing character (absent fields keep their value); async cgltf load; `error{model_load_failed}` on failure; default avatar otherwise. `null` restores a field's default: `model` (default avatar again), `name` (tag shows the id), `color` (default player/NPC color, procedural body rebuilt), `follow` (not location-driven), `isPlayer` (`false`), `scale` (1), `animations` (automatic clip matching), `showNameTag` (`false`, tag removed); `id`/`position` are not nullable | ignored + warn log | M3 |
| `removeCharacters` | fire-and-forget | `CharacterSystem::remove`, `TravelPlanner::cancel` | Removes characters; running travels emit `travel:cancel` | ignored + warn log | M3 |
| `setLocationSource` | fire-and-forget | `CharacterSystem::setLocationSource` + platform location provider | `device` starts GPS (main thread), `external` waits for `pushLocation`, `simulated` runs the demo loop | ignored + warn log | M3 |
| `pushLocation` | fire-and-forget | `CharacterSystem::pushLocation` | Smoothed fix for the player (effective with `external`) | ignored + warn log | M3 |
| `travel` | fire-and-forget (answered by events) | `TravelPlanner::start` | Cancels any previous travel (`travel:cancel`), expands legs, emits `travel:start`, then `travel:progress` (subscribed) and `travel:arrive`. Moves at real-world speed per mode (`KMH / 3.6 / unitMeters` world units/s) × optional `timeScale` (finite, > 0, default 1); `travel:progress.etaSeconds` is wall-clock time at that scale (real ETA / `timeScale`) and `character:position.speedMps` the on-map ground speed, while the `route` request keeps unscaled real-world ETAs | ignored + warn log | M3 |
| `cancelTravel` | fire-and-forget | `TravelPlanner::cancel` | Emits `travel:cancel` if a travel was running | ignored + warn log | M3 |
| `setDropLayer` | fire-and-forget | `DropSystem::setLayer` | Replaces the layer; builds instance buffers; collection radius and collectors | ignored + warn log | M3 |
| `removeDropLayer` | fire-and-forget | `DropSystem::removeLayer` | Removes the layer and its instances | ignored + warn log | M3 |
| `setGeofences` | fire-and-forget | `GeofenceSystem::setGeofences` | Replaces all geofences; membership of unchanged ids preserved | ignored + warn log | M3 |
| `setBuildingStyle` | fire-and-forget | `MapSession` building overrides → extrusion paint (M2a) + custom building layer (M2c) | Per-building color, roof, facade, decorations, massing, `replaceModel` (glTF), `state`; `null` clears | `color` and `state: "captured"` (glow mix + accent ring) as data-driven extrusion paint (§2.1); `roof` (gable / dome on rectangles), `facade` and the captured flag in the custom building layer (M2c); `null` clears; decorations / massing / replaceModel warn-logged once; `error{unknown_building}` / `error{not_ready}` as engine-web | M2a (color, state), M2c (roof, facade, captured flag), M4 (decorations, massing, replaceModel) |
| `setOverlayAnchors` | fire-and-forget | `MapSession` overlay anchors → `MapAdapter::projectPoints` | Emits `overlay:positions` while anchors exist and the view changes | one `projectPoints` batch per 16 ms frame while anchors exist and the camera / viewport / anchors change (§2.1) | M2a |
| `subscribe` | fire-and-forget | `SubscriptionRegistry` (in `Dispatcher`) | Topic × optional id × `throttleMs`; samples `CharacterSystem` / `CameraController` / `TravelPlanner` each tick | `camera:change` → `SubscriptionRegistry` (emitted once on subscribe, then throttled); other topics warn-logged | M1 (`camera:change`), M3 |
| `unsubscribe` | fire-and-forget | `SubscriptionRegistry` | Removes the subscription with the same topic and id | `camera:change` removed (id ignored, as engine-web); other topics warn-logged | M1 (`camera:change`), M3 |
| `request` | request → `response` | `project`, `unproject` → `CameraController`; `snapToRoad`, `route` → `TravelPlanner` | Always answered with exactly one `response` (same `requestId`); failures use `ok: false` | `project` / `unproject` answered asynchronously through the adapter (`ok: false`, `not_ready` without an attached, laid-out view or when it detaches); `snapToRoad` / `route` → `ok: false`, `unsupported` | M1 (`project`, `unproject`), M3 (`snapToRoad`, `route`) |
<!-- protocol-commands:end -->

### 5.2 Events (engine → host) — all 16 `ENGINE_EVENT_TYPES`

<!-- protocol-events:start -->
| Event | Emitted by | Trigger | Delivery | Current (M1) | Full in |
| --- | --- | --- | --- | --- | --- |
| `ready` | `Engine::start` → `Dispatcher::emitReady` | Engine created and sink attached | Once; `engine.kind = "native"` | emitted | M0 |
| `error` | `Dispatcher` (`invalid_message`), world loader (`world_load_failed`), `CharacterSystem`/`DropSystem` (`model_load_failed`), any subsystem (`internal`) | Decode failure, load failure, unexpected failure | Immediate (next batch) | `invalid_message`, `world_load_failed`, `unsupported`; `unknown_building` / `not_ready` from `setBuildingStyle` | M0 / M3 |
| `labelsIndex` | `LabelSystem::rebuildIndex` | After every successful world load | Once per load | not emitted | M2b |
| `map:press` | `MapSession::tap` → `MapAdapter::queryBuilding` | Tap whose ray hits the ground and no building | Immediate (after the platform query) | emitted (ground coordinate under the tap) | M2a |
| `building:press` | `MapSession::tap` → rendered-feature query of the extrusion layer (M2a; the custom layer has no picking hook, roofs above the walls are not pickable) | Tap on an extruded or replaced building | Immediate (after the platform query) | emitted (ground point on the footprint, else its centroid) | M2a |
| `drop:collect` | `DropSystem::update` | Collector within `collectRadiusMeters`; nonce from platform CSPRNG | Immediate; drop removed first (never twice) | not emitted | M3 |
| `travel:start` | `TravelPlanner::start` | Accepted `travel` | Immediate, before any progress | not emitted | M3 |
| `travel:progress` | `SubscriptionRegistry` sampling `TravelPlanner::active` | Topic `travel:progress` subscribed | Throttled (`throttleMs`) | not emitted | M3 |
| `travel:arrive` | `TravelPlanner::update` | Destination reached | Immediate | not emitted | M3 |
| `travel:cancel` | `TravelPlanner::start` / `cancel`, `CharacterSystem::remove` | Superseded, cancelled or character removed | Immediate | not emitted | M3 |
| `geofence:enter` | `GeofenceSystem::update` | Character crosses into a geofence | Immediate | not emitted | M3 |
| `geofence:exit` | `GeofenceSystem::update` | Character leaves a geofence (or geofence removed) | Immediate | not emitted | M3 |
| `character:position` | `SubscriptionRegistry` sampling `CharacterSystem::states` | Topic subscribed (optionally per id) | Throttled | not emitted | M3 |
| `camera:change` | `SubscriptionRegistry` sampling `CameraController::state` | Topic subscribed and camera changed | Throttled | emitted by `MapSession` (after a world load; gestures, animations and `setCamera`) | M1 |
| `overlay:positions` | `MapSession` (`projectPoints` replies) | Anchors exist and the view or anchors changed | At most once per frame (16 ms) | emitted | M2a |
| `response` | `Dispatcher` (per request method handler) | Every `request` | Exactly once per `requestId` | `project` / `unproject` results; `not_ready`; `unsupported` for M3 methods | M1 / M3 |
<!-- protocol-events:end -->

The table coverage is enforced by `npm test` [V: `scripts/check-design-coverage.mjs` fails when a name in
`ENGINE_COMMAND_TYPES`, `ENGINE_EVENT_TYPES` or `REQUEST_METHODS` is missing, duplicated or unknown].

## 6. Maprama layer

### 6.1 Custom layer API vs style-spec extension

| Option | Pros | Cons |
| --- | --- | --- |
| A. MapLibre custom layer API (host callback per frame) | No fork patches; upstream-supported | The legacy `CustomLayer` is GL-only [U]. The newer drawable-based custom layer for Metal/Vulkan is still evolving [U]. No style-JSON placement, no picking hooks, limited access to depth and shadow passes. |
| B. Style-spec extension: a new layer `type: "maprama"` implemented in the renderer | Participates in style ordering and zoom ranges. Shares depth with fill-extrusion and symbols. Gets theme-driven paint properties. | Requires patches to style parsing, the layer factory and the render layer. These are maintained in the queue. |
| Original decision (M0): B, built as a thin wrapper over A's drawable machinery | The patch registers a `maprama` layer type whose `RenderMapramaLayer` delegates drawing to `MapramaLayer` in our core, using the drawable/custom-drawable APIs. | Needs the fork; kept as the fallback only. |
| **Decision (M2c): A on the official SDKs** | iOS 6.30 `MLNCustomStyleLayer` (Metal: `renderEncoder`, `renderPassDesc`, `commandBuffer`) and Android 13.6.1 `CustomLayer(id, hostPtr)` over `mln::style::CustomLayerHost` (GL ES 3). The layer is a drawable of the translucent pass inside MapLibre's own render pass, placed by style order, and gets `projectionMatrix` / `nearClippedProjectionMatrix` [V: `src/mln/renderer/layers/render_custom_layer.cpp`, `drawable_custom_layer_host_tweaker.cpp` at the pinned tag]. | No picking hook (presses stay on the extrusion query); depth sharing relies on the behaviour below; the Android default artifact is Vulkan (see below). |

**Depth sharing (verified against the pinned sources, then on both simulators).** Fill-extrusions draw with
`nearClippedProjMatrix` and `depthModeFor3D()`; the custom layer uses the same matrix, `LessEqual` and depth
writes, so walls, roofs and facades occlude each other exactly:

- **Metal (iOS) and Vulkan:** `depthModeFor3D()` has no range, fill-extrusions use the full `[0, 1]`; the layer
  needs nothing else. The layer resets the depth bias it uses (MapLibre does not track it).
- **GL (Android `android-sdk-opengl`):** fill-extrusions use `glDepthRange(0, R)` with
  `R = 1 − (layerGroups + 2)·3·2⁻¹⁶`, and MapLibre sets `[d, d]` with `d = R + (1 + L)·3·2⁻¹⁶` for the custom
  layer's sublayer, `L` = layer groups above it (`renderer_impl.cpp`, `paint_parameters.cpp`). Layers above the
  first 3D layer get depth disabled (`opaquePassCutoff`), so the layer sits **below** `buildings` and reads
  `GL_DEPTH_RANGE`: `R = glExtrusionDepthRange(d, layersAbove)` (`BuildingMesh.hpp`, unit-tested), then draws
  with `glDepthRangef(0, R)`. It restores the polygon offset it uses (MapLibre does not track it).
  `layersAbove` counts style layers, which is ≥ the layer groups above (a layer without drawables has no
  group), so any error puts the custom layer slightly in front (never behind) the walls it decorates; on
  the emulator the recovered range was `R = 0.999222` with `layersAbove = 2`. The first frame after a style
  load can carry no sublayer depth (`[0, 1]`); the layer then keeps the last recovered range (1 of 240 frames).
- **Android backend:** `org.maplibre.gl:android-sdk:13.6.1` renders with Vulkan (its AAR contains
  `VulkanRendererStrategy` and Vulkan symbols); a Vulkan host would have to build `VkPipeline`s against
  MapLibre's render pass through `vk::detail::DispatchLoaderDynamic` from vulkan-hpp, whose layout must match
  the SDK's build. The package therefore depends on the **`android-sdk-opengl`** artifact of the same version
  (same Java/Kotlin API). The AAR ships no C++ headers: the three `custom_layer*` headers the host needs are
  vendored unchanged from tag `android-v13.6.1` in `android/src/main/cpp/vendor/maplibre` (BSD-2-Clause,
  root `NOTICE`); `custom_layer.hpp` is not vendored (it pulls in the whole style API and is not needed).
  The host object crosses the `.so` boundary only through the virtual `CustomLayerHost` interface and the
  POD `CustomLayerRenderParameters`.

World-unit geometry is placed with `Projection` (§6.7) and converted into web mercator once per mesh build,
never per frame; the per-frame work is one matrix product and two draw calls.

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
  frames with a pending tap (fork fallback; the SDK custom layer has no picking hook).

**M2c on the official SDKs (implemented).** The walls stay MapLibre `fill-extrusion`s (M2a: presses, base
colour, lighting); the custom building layer adds, per engine-web's `BuildingRenderer` with box massing
[V: `cpp/src/BuildingMesh.cpp`, `cpp/tests/m2c_tests.cpp`]:

| Feature | Rule (engine-web) | Native geometry / shading |
| --- | --- | --- |
| Gable roof | rectangles (`asRectangle`, 6°), `roof: "gable"`, not `flatRoofs` unless set explicitly | triangular prism along the long side, span + 0.3 overhang, ridge `H + span·0.42`; tiles / metal / darker wall colour by set |
| Dome roof | rectangles, `roof: "dome"` | drum (r = short side · 0.42, 0.3 tall) + hemisphere, apex `H + 0.3 + r` |
| Flat roof | everything else | `real`: gravel slab + parapet + HVAC; `modern` / `urban`: membrane + parapet + deck / planters / solar / HVAC; `soft`: small dome; `toy` / `none`: light overhanging cap slab — same mulberry32 draws |
| Facade | `buildings.facade` and a set ≠ `none`, per-building `facade: false` | one quad per wall 0.006 units outside the extrusion; the fragment shader draws the set's window layout (punched / ribbon / curtain wall, cell sizes of the facade textures) in the building colour, lit windows at night (`TIMES.lights`); storefront band for `real` / `modern` / `urban` |
| Facade details | `buildings.details` with `real` / `modern` / `urban` | slab-edge bands, glass fins, office fins, balcony slabs, cornice, storefront canopy (balcony glass rails are omitted) |
| Outline | `buildings.outline` (toy) | 2 dp INK lines on corners, ground ring, cap / roof edges and eaves (screen-space quads instead of the inverted hull) |
| Captured | `state: "captured"` | the extrusion's glow mix (M2a) on the facade too, plus the pole + ACCENT flag on the roof |

Differences to engine-web: the facade textures are procedural patterns (no texture atlas yet), rectangle
geometry follows the true footprint (the extrusion does), `massing: "varied"` / decorations / replaced models
are not drawn, the captured glow does not pulse, and `soft` masses are not rounded.

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

**Decision.** GPU quads rendered by `MapramaLayer` for every style, which is consistent with engine-web's
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
2. **MapramaLayer uniforms:** hemisphere and sun light (`TIMES[timeOfDay]` × `hemiMul`/`sunMul`), fog
   near/far/color, exposure, tone mapping (`toneMapped`), `shading` (`standard` PBR-lite vs `toon` ramp),
   `edgeLines` / outline pass, facade set and palette, landmark colors, and window lights (`lights`).
3. **Post pass:** the CSS gradients (`haze`, `vignette`, cinematic `grade`) are parsed once into 256×1 ramp
   textures and composited in a single full-screen pass with `hazeOpacity` / `grade`.

A theme change interpolates numeric uniforms over 300 ms. Changes to toggles (facade, outline, massing)
rebuild only the affected geometry chunks on workers.

**M2a (official SDKs).** The built-in data is embedded by `scripts/generate-theme-data.mjs` into
`cpp/src/ThemeData.cpp` instead of platform-bundled JSON files (no file loading in the wrappers; `npm test`
fails when the file drifts from the protocol), and `ThemeResolver::resolve` is checked against
`resolveTheme` for every preset × time of day × cinematic plus field overrides and custom preset objects
[V: `theme.json` fixture, `theme_resolver_matches_resolve_theme`]. Place 1 is implemented with style
layers, the style light and a time-of-day colour tint (§2.1). **M2c** implements place 2 for buildings: the
custom building layer takes the style light (MapLibre's extrusion lighting), the tinted colours, the facade
set, outlines, details and window lights. The post pass (haze, vignette, cinematic grade), fog and the 300 ms
cross-fade remain open (M4).

### 6.7 Coordinates and zoom-out game view

- World units follow `Projection` (a port of `createProjection` with identical math and verified within
  1e-6 world units [V: `projection_tests.cpp`, 35 origin × unit combinations]). The mapping to MapLibre
  mercator is computed once per world as an affine transform around the origin. Its error is below 1 cm
  across a 5 km world [E].
- `ZoomOutBehavior`:
  - `none` keeps the diorama at every zoom.
  - `mapColors` cross-fades the maprama layer's opacity to 0 between camera distance D1 and D2 (default
    zoom 14 → 13 [E]) while MapLibre's flat vector layers fade in with preset-derived colors.
  - `keepGameView` keeps the maprama. Beyond D2 buildings switch to merged low-LOD roof-only impostors, and
    characters and drops become icon sprites, so the draw calls stay within budget.

### 6.8 Procedural worlds (M2b)

`init` with `world: {kind: "procedural", layout, seed?}` runs a C++ port of engine-web's generators:
`cpp/src/ProceduralWorld.cpp` (← `src/world/town.ts`, `grid.ts`, `shapes.ts` and the `polygon.ts` helpers
they use) and `cpp/src/RoadGraph.cpp` (← `src/world/graph.ts` `buildGraph` / `snap`, reusable by M3
routing). The same seed gives the same world as engine-web.

- **Determinism rules.** mulberry32 runs on `uint32` (identical to the JS `| 0` / `Math.imul` code,
  including the `ToInt32` wrap of large seeds); every random draw happens in the JS order (never two draws
  in one C++ expression, because C++ does not sequence operands); `Math.round` / `Math.hypot` use V8's
  semantics (`js_math`; hypot is V8's normalised Kahan sum); `Array.prototype.sort` becomes
  `std::stable_sort`; both files compile with `#pragma clang fp contract(off)` so arm64 clang does not fuse
  `a * b + c` (V8 never does). `sin` / `cos` / `atan2` / `pow` come from the platform libm.
- **Conformance.** `scripts/export-fixtures.mjs` exports engine-web's `buildTownWorld` /
  `buildGridWorld` (built dist) for town seeds 0, 7, 42, −5, 2147483000 and grid seeds 0, 7, 42,
  2147483640, plus raw mulberry32 sequences, into `procedural.json`; `procedural_tests.cpp` compares every
  field. Counts, ids, names, road classes, graph topology, building kinds, roofs, palette indices,
  decorations, massing and landmarks match exactly; numbers are checked within 1e-9 relative
  [V: `procedural_worlds_match_engine_web`]. On macOS ≈ 99 % of the ~46 k numbers are bit-exact and the rest
  differ by ≤ 1.5e-14: on random inputs Apple's `sin` / `cos` differ from V8 in the last bit for ~4 % of
  arguments and `atan2` for ~18 % (`pow` matched all samples). A last-bit difference changes the world's
  structure only if a sample lands within one ulp of an occupancy-cell boundary or a threshold (≈ 10⁻⁷ per
  world [E]), so iOS (Apple libm), Android (bionic) and engine-web build the same buildings in practice.
  Porting fdlibm's `sin` / `cos` / `atan2` is the fallback if strict bit-equality is ever required.
- **Into the style pipeline.** `proceduralWorldData` converts the generated world to WorldData v1 and
  `MapSession::loadProceduralWorld` loads it through `WorldStore::load` exactly like a `data` world (same
  validation, style, extrusion, themes, building styles, presses): roads = the generated polylines (engine-web
  draws the planarised graph edges, which also drops dangling stubs shorter than 2.5 units), buildings = the
  lot footprints with height and kind, water = the river ribbon as a polygon (+ the grid park ponds), parks =
  the river banks, the named town parks and the grid park blocks; POIs, stations, districts and the plaza
  unchanged. Two things WorldData cannot carry are passed alongside: the generator's `start` (default
  framing, like engine-web's `loadWorld`) and each building's palette index `ci` (engine-web keeps the
  generator's value; `data` worlds use `hashId(id) % 6`). Look-only attributes (roof shape, decorations,
  massing, scenery trees, landuse pads, grid block pads) stay on `ProceduralWorld` for M2c.
- **Time.** Apple M5 Pro, `-O2`: town 3.6 ms to generate (4.1 ms with the WorldData conversion and the
  `WorldStore` load), grid 0.04 ms (0.3 ms); engine-web in node needs ~45 ms for the town. The core logs
  `generated procedural <layout> (seed …, N buildings) in X ms` on every load (generation + conversion):
  town seed 7 took 13 ms in the Release example on the iOS simulator (first load, cold process) and
  4.6 ms on the arm64 Android emulator [V: device logs], far inside a 100 ms budget; real phones are
  expected within a few times the Mac figure [E].

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
| `maprama_roads` | LineString | `id` (string), `cls` (`arterial`/`local`/`alley`), `name`?, `bridge`? (bool) | `roads[]` |
| `maprama_buildings` | Polygon (exterior ring, positive shoelace area in world `[x, z]` after projection) | `id`, `height_m` (meters; world `height = height_m / unitMeters`), `levels`?, `kind`?, `name`? | `buildings[]` |
| `maprama_water` | Polygon | none | `water[]` |
| `maprama_parks` | Polygon | `name`? | `parks[]` |
| `maprama_pois` | Point | `id`, `name`, `cat` (`POI_CATEGORIES`) | `pois[]` |
| `maprama_stations` | Point | `id`, `name` | `stations[]` |
| `maprama_districts` | Point | `name`, `water`? | `districts[]` |

  World-level fields live in the PMTiles metadata JSON under the key `"maprama"`:
  `{version: 1, name, origin, unitMeters, bounds, plaza?, attribution[]}`. For z/x/y sources they are in
  `…/maprama.json`. Features split across tiles are deduplicated by `id`. Buildings are reassembled from the
  highest zoom that contains them.

## 8. Memory and performance budgets

Targets for a mid-range reference device (iPhone 12 / Pixel 6a class) with the Seongsu sample scaled to
20,000 buildings. All figures are **[E]** until they are measured in M4. CI perf gates are added once real
numbers exist.

| Budget | Target |
| --- | --- |
| Frame time | 16.6 ms at 60 fps (p95); core tick ≤ 2 ms; maprama encode ≤ 4 ms; MapLibre base map ≤ 5 ms |
| Native heap (engine total) | ≤ 250 MB. MapLibre tile cache 50 MB, maprama geometry ≤ 60 MB, textures ≤ 64 MB, characters ≤ 8 MB each, other |
| GPU draw calls | ≤ 150 per frame (buildings chunked by 256 m cells; drops 1 call per type × rarity; labels ≤ 3) |
| Characters | ≤ 32 skinned, ≤ 64 joints each |
| Drops | ≤ 5,000 active, ≤ 1,500 visible |
| Labels | ≤ 1,000 indexed, ≤ 300 placed per frame |
| Message decode | Typical command ≤ 0.2 ms; `init` with a 5 MB inline world ≤ 150 ms on a worker (p95) |
| Latency | JS `send` → applied ≤ 1 frame; event emitted → JS handler ≤ 1 frame |
| Cold start | View mount → `ready` ≤ 300 ms; `init` → first maprama frame ≤ 1 s (sample world) |
| Binary size | ≤ +12 MB per ABI (MapLibre + core), excluding assets |
| Battery | `device` location source ≤ 5 %/h additional drain in foreground [E] |

The skeleton's own numbers are not budget evidence. It is built with ASan/UBSan for tests
[V: `scripts/build-core.sh --tests`].

**M2c measurements (Seongsu, 428 buildings; simulators, not the reference devices).** The custom layer logs
`maprama-frame-stats` every 240 drawn frames (iOS `os_log` category `building-layer`, Android logcat tag
`MapramaBuildingLayer`); the numbers below are from the Maestro flows (`07-native-m2c`: 8 s orbit around the
captured tower, realistic theme). Idle gaps > 100 ms (MapLibre renders on demand) are excluded.

| | Mesh | Frame interval avg / p95 | Layer cost per frame |
| --- | --- | --- | --- |
| Core (`m2c_building_layer_geometry`, ASan build) | 74,969 vertices, 37,643 triangles, built in ≈ 10 ms | — | — |
| iOS 26.5 simulator (Metal, M-series Mac) | same | 16.7–16.9 ms / 17.3–21.3 ms (vsync-bound 60 fps) | encode 0.005 ms; whole-frame GPU 0.12–0.27 ms |
| Android 15 emulator (`-gpu host`, GL ES translator) | same | 25.8 ms / 45.2 ms during the orbit; 3.5–6.2 ms in the M1 flow (no vsync) | GL calls 1.6 ms avg (3.7 ms p95) during the orbit, 0.25–0.43 ms otherwise |

Uploads (≈ 3.6 MB of vertices) happen only when the layer data changes. The emulator figure is bound by the
emulator's GL translation; no baseline without the layer and no device numbers were taken (M4).

## 9. Build and packaging

- The core is built by `scripts/build-core.sh` on macOS with `xcrun clang++` (no CMake on this toolchain)
  [V]. iOS compiles the same `cpp/src` from `MapramaEngineNative.podspec` (C++20 language mode, the core
  itself stays C++17) together with `ios/*.mm`. Android compiles it from `android/CMakeLists.txt` through
  Gradle `externalNativeBuild` into `libmaprama_engine.so` together with the JNI glue
  (`android/src/main/cpp/maprama_jni.cpp`); that library links no React Native code, the Kotlin view
  manager and TurboModule reach it through JNI.
- **M1:** apps link the official prebuilt SDKs — the `MapLibre` pod (dynamic XCFramework, `~> 6.30`) and
  `org.maplibre.gl:android-sdk:13.6.1` from Maven Central. Autolinking picks the package up from the
  podspec at the package root and `android/` (`react-native.config.js`); codegen (`codegenConfig`,
  `MapramaEngineNativeSpec`) generates the Fabric component and TurboModule glue on both platforms.
- **M2a:** still the official SDKs (no new native dependency).
- **M2c:** still the official SDKs. Android switches to `org.maplibre.gl:android-sdk-opengl:13.6.1` (the GL ES
  variant of the same release, §6.1) and links `GLESv3`; `libmaprama_engine.so` also compiles
  `android/src/main/cpp/maprama_building_layer.cpp` against the vendored `mln/style/layers/custom_layer*.hpp`
  headers. iOS adds `ios/MapramaBuildingLayer.mm` (Metal shaders compiled at runtime from source).
  **Fork fallback only:** if a later milestone needs the fork, the patched MapLibre is built in CI from
  `patches/` into an XCFramework (Metal) and an AAR; app builds would consume these prebuilt artifacts, so
  they never apply patches.
- Tests: `npm test -w @maprama/engine-native` runs these steps:
  1. export fixtures from the built protocol package (including `resolveTheme` cases);
  2. check DESIGN.md coverage;
  3. check that `cpp/src/ThemeData.cpp` matches the protocol's theme data;
  4. build the core plus the sanitizer test binary;
  5. run the C++ conformance and behaviour suites;
  6. validate the C++-emitted events with the TS `decodeEvent`;
  7. run the patch-queue fixture test;
  8. run the Jest tests of the `native` host.

## 10. Patch-queue workflow

The queue is **not used**: M1 and M2a run on the official prebuilt SDKs (§1), M2b and M2c are planned on
them too, and `UPSTREAM` stays unpinned. The tooling is kept (and tested) for the fallback: if M2c's custom
layer hits a wall, the first patches (a `maprama` layer type) and the pin land then.

```
packages/engine-native/patches/
  UPSTREAM                      # first non-comment line = upstream ref (tag), pinned in M2
  0001-<subject>.patch          # git format-patch output, zero commit ids, no stat/signature
  0002-<subject>.patch
scripts/patch-queue/
  apply.sh   <clone> [--patches DIR] [--base REF] [--branch NAME]
  refresh.sh <clone> [--patches DIR] [--base REF]
  rebase.sh  <clone> <new-ref> [--patches DIR] [--branch NAME]
  test.sh    # throwaway upstream fixture; run by npm test
```

- **Apply.** `apply.sh ~/src/maplibre-native` checks out `maprama/patched` at `UPSTREAM` and runs
  `git am --3way patches/*.patch`. It refuses a dirty tree, an in-progress am/rebase, an unknown ref or
  an unpinned base.
- **Develop.** Commit on `maprama/patched` with one concern per commit and the subject prefix `[maprama]`.
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
| WorldData load (`data`) | `init.world` | v1 | **M1** (flat map) |
| WorldData `url` | `init.world` | v1 | **M1** (platform fetch) |
| WorldData `procedural` | `init.world` | v1 | **M2b** (C++ port of the town / grid generators, conformance-tested, §6.8) |
| Camera + gestures | `setCamera`, `camera:change`, `project`/`unproject` | v1 | **M1** (`follow` M3) |
| Subscriptions | `subscribe` / `unsubscribe` | v1 | **M1** `camera:change`; M3 other topics |
| Buildings: extrusion, facades, roofs, massing | `setTheme`, `setBuildingStyle` | v1 | **M2a** extrusion, theme colours, colour / captured overrides; **M2c** gable / dome / flat roofs, facade windows + storefronts, facade details, captured flag (custom layer); M4 varied massing, decorations, replaced models |
| Themes + time of day + cinematic | `setTheme` | v1 | **M2a** resolution, colours, light + time-of-day tint; **M2c** outlines, window lights at night; M4 cinematic grading, fog / haze, cross-fade |
| Labels (all styles, custom content) | `setLabels`, `setLabelContent`, `labelsIndex` | v1 | M2b |
| Map UI | `setUi` | v1 | **M2a** (location puck M3) |
| Presses | `map:press`, `building:press` | v1 | **M2a** (rendered-feature query) |
| Overlay anchors | `setOverlayAnchors`, `overlay:positions` | v1 | **M2a** |
| Characters (glTF skinning) + location sources | `upsertCharacters`, `removeCharacters`, `setLocationSource`, `pushLocation`, `character:position` | v1 | M3 |
| Travel + routing | `travel`, `cancelTravel`, `travel:*`, `snapToRoad`, `route` | v1 | M3 |
| Drops | `setDropLayer`, `removeDropLayer`, `drop:collect` | v1 | M3 |
| Geofences | `setGeofences`, `geofence:*` | v1 | M3 |
| Zoom-out game view | `theme.zoomOut` | v1 | M4 |
| PMTiles / tile-backed WorldData | (protocol addition) | planned | planned (same release as web) |

**Milestones**

- **M0 — foundation (done).** Design, interfaces, the JS-exact JSON codec, `Projection`,
  `WorldStore`, the skeleton dispatcher (`unsupported` responses, warn-logged fire-and-forget), fixture
  conformance tests, patch-queue tooling.
- **M1 — map on screen (done), on the official prebuilt MapLibre SDKs (§1).**
  - `MapramaNativeView` + `MapramaEngineModule` on both platforms (codegen Fabric component + Obj-C/Java
    TurboModule, §4.1), the `native` engine host (`import '@maprama/engine-native'`).
  - `MapAdapter` (§2.1) implemented with `MLNMapView` (iOS) and `MapView`/`MapLibreMap` (Android).
  - `init` with `data` / `url` worlds rendering the flat map (style JSON with GeoJSON sources).
  - Camera + gestures (pitch 0–60°, engine-web distance limits), `setCamera` merge, `project`/`unproject`,
    `SubscriptionRegistry` with throttled `camera:change`.
  - Deferred from the original M1 plan: pinning `UPSTREAM`, the first patches and the CI XCFramework/AAR
    (all move to M2 with the fork), the core-thread command queue, frame snapshot and per-tick event
    batching (§3 M1 simplification), and `procedural` worlds (M2b).
- **M2 — diorama look, on the official SDKs in three steps.**
  - **M2a (done).** `ThemeResolver` (embedded protocol data, conformance-tested), 3D buildings as a
    `fill-extrusion` layer in theme colours, time of day as the style light + colour tint, `setTheme` paint
    patches, `setBuildingStyle` (colour, captured), presses through rendered-feature queries, map UI (scale
    bar, zoom buttons, attribution, MapLibre ornaments), overlay anchors (`overlay:positions`).
  - **M2b.** Labels as a native view pool driven by the core (`labelsIndex`, `setLabels`,
    `setLabelContent`, the label styles as far as views allow) and `procedural` worlds (**done**: C++ port
    of engine-web's generators with a conformance fixture, loaded through the WorldData path, §6.8).
  - **M2c (this change).** The custom building layer on the SDKs' custom layer APIs (iOS
    `MLNCustomStyleLayer` on Metal, Android `CustomLayerHost` on GL ES 3 with `android-sdk-opengl`): roofs,
    facade windows / storefronts / details, outlines and the captured flag from core meshes, depth-shared with
    the extrusions (§6.1, §6.2). Not in M2c: varied massing, decorations, replaced models, ID-buffer picking,
    cinematic grading / post pass (M4); the layer has no per-frame core data yet, so the core thread + frame
    snapshot (§3) are still not needed.
  - **Fallback.** Fork + patch queue (pin `UPSTREAM`, `maprama` layer type, CI artifacts) and an
    `mbgl`-backed `MapAdapter`, only if a later milestone cannot be built on the SDKs' custom layer APIs.
- **M3 — game systems.** cgltf skinning, `CharacterSystem` and location sources, `TravelPlanner` (A*,
  subway expansion), drops, geofences, all remaining events.
- **M4 — parity and performance.**
  - Zoom-out game view.
  - Device perf and memory measured against §8.
  - Parity matrix all green using the RN example app, with the web and native engines side by side.
  - `engine="native"` beta.

## 12. Third-party components (NOTICE list for this package)

| Component | License | Used for | Status |
| --- | --- | --- | --- |
| MapLibre Native | BSD-2-Clause | Base renderer: official prebuilt iOS / Android SDKs linked by apps (M1); three `custom_layer*` headers vendored in `android/src/main/cpp/vendor/maplibre` (M2c) | used; root `NOTICE` entry with the license text (M2c) |
| cgltf | MIT | glTF 2.0 / GLB loading | planned (M3) |
| earcut.hpp | ISC | — | **not used**: roof caps use a small ear-clipping triangulator in `BuildingMesh.cpp` (MapLibre's bundled copy is not reachable through the prebuilt SDKs) |
| nlohmann/json | MIT | — | **not used** (self-written JS-semantics parser, §6.4) |

## 13. Core behaviour summary (M1 + M2a + M2c)

| Input | Output |
| --- | --- |
| Engine `start()` | `ready {engine: {name: "maprama-native", version: "0.1.0", kind: "native"}}` |
| Envelope failing `decodeCommand` rules | `error {code: "invalid_message", message: <exact decodeCommand error>, fatal: false}` |
| `init` with `world.kind = "data"` / `"url"` | `WorldStore` loaded, map style sent, default framing then `init.camera`; load failures `error {world_load_failed, fatal: true}` (url messages as engine-web: `HTTP <status> while loading <url>`, `failed to load <url>: …`, `invalid WorldData from <url>: …`); theme and ui applied; labels and locationSource warn-logged |
| `init` with `world.kind = "procedural"` | World generated by the C++ port of engine-web's town / grid generators (same seed → same world, §6.8), converted to WorldData and loaded like `data` (extruded buildings keep the generator's palette index); default framing at the generator's start point, then `init.camera` |
| `setCamera` | Merged into the camera and applied to the map (§5.1); `follow: "<id>"` warn-logged |
| `setTheme` | Resolved theme → changed paint properties + light, and the rebuilt custom building layer (facades, details, outlines, window lights); varied massing / grading / zoomOut warn-logged once |
| `setBuildingStyle` | Colour / captured override as data-driven extrusion paint; roof / facade / captured flag in the custom building layer; `error {unknown_building \| not_ready, fatal: false}` |
| World load, `setTheme`, `setBuildingStyle`, adapter attach | `MapAdapter::setBuildingLayer(data)` after the style, only when the layer content changed |
| `setUi` | `MapUiState` (scale bar, zoom buttons + compass, attribution + logo) sent when it changes; `locationPuck` warn-logged |
| `setOverlayAnchors` | `overlay:positions {positions: [{id, x, y, visible}]}` at most once per 16 ms frame while the view changes |
| Platform tap | `building:press {buildingId, coordinate}` or `map:press {coordinate}` |
| `subscribe` / `unsubscribe` `camera:change` | `camera:change {camera: {center, distance, pitch, bearing ∈ [0, 360)}}` once on subscribe (after a world load), then throttled on every change |
| `request` `project` / `unproject` | `response {ok: true, result: {x, y, visible} \| {coordinate \| null}}` through the adapter; `ok: false, not_ready` without a laid-out view |
| `request` `snapToRoad` / `route` | `response {requestId, ok: false, error: {code: "unsupported", message}}` |
| Any other command | Ignored with a `LogLevel::Warn` log (the protocol has no warning event) |
| Outgoing events (debug/tests) | Validated with `validateEngineEvent`; invalid ones dropped and logged |
