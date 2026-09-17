# `@maprama/engine-native` — native engine v2 design

Status: **M2b labels (native label views and character name tags)** and **M4 (zoom-out game view, performance and parity)** on top of M3b (3D characters and drop models in the custom layer), M3a (game
systems), M2c (diorama look, part 2: custom building layer), procedural worlds (M2b), M2a (diorama look,
part 1) and M1 (map on screen). This package contains:

- this design;
- the C++ core (`cpp/`): protocol codec, `WorldStore`, `Projection`, `ThemeResolver`, the dispatcher, the
  label system (`LabelSystem`: engine-web's label selection and placement and the character name tags, §6.5), the
  map session (world → MapLibre style with 3D buildings in theme colours, camera, `camera:change`,
  `project`/`unproject`, `setTheme`, `setBuildingStyle`, presses, map UI, overlay anchors, labels) behind the
  `MapAdapter` interface (§2.1), the M2c building meshes (roofs, facade windows and details, outlines,
  captured flag; `BuildingMesh`, §6.2) and the game session (characters, location sources, travel + routing,
  drops, geofences, camera follow, §2.2) with its overlays as GeoJSON style layers and, since M3b, glTF /
  procedural characters, vehicles and drop items as a skinned model pass of the custom layer (§6.3, §6.4), with
  their conformance and behaviour tests;
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
│   GameSession: characters · location · travel · drops · geofences (M3a)      │
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
| `setUi(state)` (M2a) | own scale bar / zoom buttons / attribution label + `logoView`, `attributionButton`, `compassView`, all laid out inside `MapUiState::inset` (`logoViewMargins` / `attributionButtonMargins` / `compassViewMargins`, M5) | own views in the `FrameLayout` + `UiSettings` logo / attribution / compass, same inset (`setLogoMargins` / `setAttributionMargins` / `setCompassMargins`, M5) | zoom buttons → `Engine::zoomButton(in)` |
| `setBuildingLayer(data)` (M2c) | `MapramaBuildingLayer` (`MLNCustomStyleLayer` subclass, Metal) inserted below `buildings` after every style load; `setData:` + `setNeedsDisplay` | `BuildingLayerState` (shared with the render thread) + `CustomLayer("maprama-buildings-3d", BuildingLayerHost*)` added below `buildings` (`MapramaJni.createBuildingLayerHost`), `triggerRepaint` | — |
| `setCameraLimits(minZoom, maxZoom, minPitch, maxPitch)` | `minimum/maximumZoomLevel`, `minimum/maximumPitch` | `setMin/MaxZoomPreference`, `setMin/MaxPitchPreference` | — |
| `moveCamera(pose, durationMs)` | `setCamera:(animated:\|withDuration:)` (altitude via `MLNAltitudeForZoomLevel`) | `moveCamera` / `easeCamera(CameraUpdateFactory.newCameraPosition)` | camera reports below |
| `project(token, lngLat)` | `convertCoordinate:toPointToView:` | `projection.toScreenLocation` (px → dp) | `Engine::onProjected(token, x, y)` |
| `projectPoints(token, lngLats)` (M2a) | `convertCoordinate:toPointToView:` per anchor | `projection.toScreenLocation` per anchor | `Engine::onPointsProjected(token, points)` |
| `unproject(token, x, y)` | `convertPoint:toCoordinateFromView:` | `projection.fromScreenLocation` (dp → px) | `Engine::onUnprojected(token, lngLat?)` |
| `queryBuilding(token, x, y)` (M2a) | `visibleFeaturesAtPoint:inStyleLayersWithIdentifiers:{buildings}` + `convertPoint:toCoordinateFromView:` | `queryRenderedFeatures(PointF, "buildings")` + `fromScreenLocation` | `Engine::onBuildingQueried(token, id?, ground?)` |
| `fetchText(token, url)` | `NSURLSession` | `HttpURLConnection` on a worker thread | `Engine::onTextFetched(token, ok, body \| message)` |
| `scheduleFrame(delayMs)` | `dispatch_after` on the main queue | `Handler.postDelayed` on the main looper | `Engine::frame(t)` |
| `setModelLayer(frame)` (M3b) | `MapramaBuildingLayer setModelFrame:` (the same `MLNCustomStyleLayer`: model pass after the building meshes) + `setNeedsDisplay`, one main-thread hop per batch of frames | `BuildingLayerState::setModelFrame` read by the `BuildingLayerHost` on the render thread, `modelLayerChanged()` → coalesced `triggerRepaint` | — |
| `setBuildingLayerZoom(zoom)` (M4) | `MapramaBuildingLayer setZoom:` (height-scale uniform, low-detail index buffer) | `BuildingLayerState::setZoom` read by the `BuildingLayerHost` on the render thread, coalesced `triggerRepaint` | — |
| `fetchBinary(token, url)` (M3b) | `NSURLSession` (http(s) and file URLs) | `HttpURLConnection` / `File` on a worker thread | `Engine::onBinaryFetched(token, ok, bytes \| message)` |
| `setSourceData(sourceId, geojson)` (M3a) | `MLNShapeSource.shape = [MLNShape shapeWithData:…]`, the latest data per source kept until `didFinishLoadingStyle` | `GeoJsonSource.setGeoJson(json)` in `getStyle {}` of the current style generation, one pending update per source | — |
| `startLocationUpdates()` / `stopLocationUpdates()` (M3a) | `CLLocationManager` (best accuracy, no distance filter); not authorised → error, started again on `locationManagerDidChangeAuthorization` | `LocationManager` GPS + network providers (1 s); no `ACCESS_FINE/COARSE_LOCATION` → error | `Engine::onDeviceLocation(fix)`, `Engine::onDeviceLocationError(message)` |
| (pan observer, M3a) | `mapView:regionWillChangeWithReason:animated:` with `MLNCameraChangeReasonGesturePan` | `addOnMoveListener` (`onMoveBegin`) | `Engine::onUserPan()` (stops `setCamera.follow`) |
| `measureLabels(token, contents)` (M2b) | `MapramaLabelLayer` lays a scratch card out (`sizeThatFits` + engine-web paddings) | `LabelCardView.configure` (`Paint.measureText` + paddings) | `Engine::onLabelsMeasured(token, sizes)` |
| `setLabelFrame(frame)` (M2b) | `MapramaLabelLayer applyFrame:` (views recycled by label id; applied in the same run-loop turn when called on the main thread); M5: marker cards are drawn from the same pool | `MapramaLabelLayer.apply` (same) | VoiceOver / TalkBack activating a marker card → `Engine::tap` at the card (M5) |
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
- **Labels (M2b).** The core builds engine-web's label index on every world load (`labelsIndex`), resolves
  `setLabels` / `setLabelContent`, and on every camera report projects, declutters and clamps the labels
  itself (§6.5) — no projection round trip, so the cards move with the map. The platform only measures cards
  (`measureLabels`, cached by content key) and draws the placed ones (`setLabelFrame`, sent only when it
  changed). On iOS `automaticallyAdjustsContentInset` is off and `MLNMapView.contentInset` stays zero, so the
  MapLibre camera target is the view centre, as in the core's own projector. `ui.contentInset` is applied by
  moving the camera instead (`MapSession::poseFor` sends `centre − insetShift`, engine-web's
  `CameraController.apply`), which keeps the core's projection and the map in agreement without an off-axis
  frustum. Markers ride in the same frame (§6.9).
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
  MapLibre zoom limits for gestures; pitch is limited to 0–60°. A camera that waits for the viewport (no
  laid-out view yet) stays the target: camera reports that arrive before it reached the map describe the
  map's own initial pose (0,0, zoom 0) and are ignored [V: `m1_camera_report_before_viewport_keeps_world_camera`].
- **Replies are asynchronous.** The core calls the adapter with its lock held; the adapter posts to the
  main thread and answers through the Engine's `on*` methods, which take the lock again. Pending
  `project`/`unproject` requests are answered with `ok: false` (`not_ready`) when the view detaches.
- **Fork fallback.** Not needed for M2c (§1, §6.1): an adapter implemented on `mbgl::Map` (patched fork) would
  replace both platform adapters; `MapSession`, the style builder, `BuildingMesh` and the tests stay.

### 2.2 Game session (M3a)

`GameSession` (`cpp/include/maprama/GameSession.hpp`) sits next to `MapSession` and wires the pure ports of
engine-web's game logic (`TravelLogic`, `LocationFilter`, `DropLogic`, `GeofenceLogic`, `RoadGraph`, all
fixture-conformance tested) with engine-web `Features` semantics [V: `cpp/tests/game_session_tests.cpp`]:

- **World hooks.** `MapSession` calls `MapSessionHooks` to add the game sources / layers to every style it
  builds, after every complete style (`styleSent`: the game sources are re-sent), after a world load (before
  `init.camera`, which may follow a character) and for `setCamera.follow`. On a world load running trips are
  cancelled (`travel:cancel`), characters keep their geographic position, the road graph / stations
  (`planWorldFromData`; `planWorldFromProcedural` on the generated world for a `procedural` init, whose
  start, `loopWays` and `groundYFor(layout)` also replace the data-world spawn / demo loop / ground height) and
  the demo loop are rebuilt, and drop layers and geofences are re-projected.
  Characters, drop layers and geofences sent before the first world wait for it (engine-web's deferred state).
- **Commands.** `upsertCharacters` (merge; `null` restores a default; more than one player →
  `error {invalid_character}`), `removeCharacters` (cancels trips, stops following), `setLocationSource`,
  `pushLocation`, `travel` (`not_ready` without a world, `unknown_character`; `timeScale` = map-level
  `travelTimeScale` or per-call override, as on web), `cancelTravel`, `setDropLayer` / `removeDropLayer`,
  `setGeofences`, `setCamera.follow` (`unknown_character` fails the whole command, a `center` without
  `follow` and a user pan stop following), the `character:position` / `travel:progress` topics (throttled per
  subscription and key like engine-web `ThrottledTopic`, `SubscriptionRegistry::due`) and the `route` /
  `snapToRoad` requests (`not_ready` without a world). Error messages carry engine-web's command prefix.
- **Tick.** One simulation tick per `MapAdapter::scheduleFrame` frame, in engine-web's `Features.frame`
  order: simulated location step, follower steps (+ `travel:arrive`), drop checks (`drop:collect`), geofence
  enter / exit, camera follow (`1 − e^(−5 dt)` towards the character), `character:position`,
  `travel:progress`, then the changed game sources and (M3b) the model frame. dt is clamped to 50 ms like engine-web's render loop. Frames
  are requested only while something moves: 16 ms while a character moves / waits for a vehicle, the camera
  catches up with a followed character or (M3b) any character or drop item is on screen (idle clips, breathing,
  drop bob / spin / pop animate every frame, like engine-web's render loop); 250 ms while only the `simulated`
  walker runs (it advances in wall-clock time); none otherwise. Frames requested by the map session are ignored by the game
  session (and vice versa) so the two never multiply each other's frame chains.
- **Device location.** `setLocationSource {kind: "device"}` starts the platform feed
  (`MapAdapter::startLocationUpdates`); fixes go through `LocationService::onDevice`, failures become
  `error {location_unavailable, "device geolocation failed: <message>"}` (engine-web's code and prefix).
  Requesting the permission is the app's job.
- **Visuals** (`cpp/include/maprama/GameVisuals.hpp`). Three GeoJSON sources updated with
  `MapAdapter::setSourceData` only when they changed: geofences (fill 7 % + ring 85 %, 80 segments,
  engine-web's `min(0.35, 0.2 r)` ring width), the player's route (lines by mode in engine-web's route colours,
  subway station rings, destination pin) and the location puck (accuracy disc from the last smoothed fix while
  the player follows the location, dot under the player). Ground layers (geofences, route, puck accuracy) are
  inserted below the 3D buildings, and so also below the custom layer, which every platform inserts directly
  below `buildings`; the route pin and the puck dot are drawn above them; sizes are world sizes with an on-screen
  minimum. M3a's flat character / drop circles are gone: since M3b characters, vehicles and drop items are 3D
  models (`ModelLayer.hpp`, §6.3, §6.4) sent as one `ModelLayerFrame` per tick through
  `MapAdapter::setModelLayer` and drawn by the custom layer in the extrusions' depth range (occluded by and
  occluding the buildings). Name tags wait for the label view pool (M2b). Tick cost, source updates and model
  frames are logged every 5 s by the core; both platforms log the layer's per-frame cost (§8).

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

**M3b workers.** glTF parsing (cgltf, texture decoding through the platform decoder) runs on worker threads
(`EngineConfig::runAsync`, a detached `std::thread` per model by default): the worker only touches copies of its
input, then delivers the result under the engine lock through an `AsyncMailbox` that the engine's destructor
clears (a late worker never touches a destroyed engine). On Android native threads that attach to the VM are
detached when they exit (`pthread_key` destructor in `maprama_jni.cpp`). The per-tick model frame is an immutable
`shared_ptr` snapshot read by the render thread (the "frame snapshot" of queue 2, for models only).

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

### 5.1 Commands (host → engine) — all 24 `ENGINE_COMMAND_TYPES`

<!-- protocol-commands:start -->
| Command | Kind | Core subsystem(s) | Behaviour | Current (M1) | Full in |
| --- | --- | --- | --- | --- | --- |
| `init` | fire-and-forget | `WorldStore`, `ThemeResolver`, `LabelSystem`, `CameraController`, `GameSession`, map UI | `world.kind`: `data` → `WorldStore::load`; `url` → platform HTTP then `loadJson`; `procedural` → port of engine-web's generator. The core then resolves the theme, builds labels (emits `labelsIndex`), applies `ui`, sets the camera (default framing when absent), and sets the location source. Load errors emit `error{world_load_failed, fatal: true}`. | `data` and `url` (fetched by the adapter) worlds load into `WorldStore` and become the map style (§2.1); default framing (engine-web `DEFAULT_ORBIT` at the plaza) then `init.camera`; `procedural` worlds are generated by the C++ port of engine-web's generators, converted to WorldData and loaded the same way, framed at the generator's start point (M2b, §6.8; the game session plans on the generator's road graph, §2.2); `theme` and `ui` applied at once (M2a; a `setTheme` sent during a url load wins, as in engine-web); `locationSource` applied when the world loads (M3a); `camera.follow` of an unknown character → `error{unknown_character}` ("init: …"); `labels` applied at once and `labelsIndex` emitted after the load, before `init.camera` (M2b) | M1 (world, camera), M2a (theme, ui), **M2b** (labels, procedural), **M3a** (location) |
| `setTheme` | fire-and-forget | `ThemeResolver` → style paint properties + light (M2a), custom building layer (M2c), zoom-out (M4) | `resolveTheme` precedence (§6.6); cross-fades lighting over 300 ms | resolved by the C++ `ThemeResolver`; changed paint properties + light sent to the map (§2.1); facades, facade details, outlines and window lights rebuilt in the custom building layer (M2c); `zoomOut` applied (§6.7: overlay, heights, low detail, icon discs); varied massing / cinematic grading warn-logged once; no cross-fade | M2a (colours, light), M2c (facades, details, outlines), **M4** (zoomOut); grade and massing open |
| `setLabels` | fire-and-forget | `LabelSystem::setSpec` → `MapSession` label frames | Replaces the spec (defaults: enabled, `holo`, icons `auto`, `nameAndType`); re-measures and re-places the labels | spec replaced; `holo`, `app`, `minimal`, `clean`, `sticker` drawn as native views; `ground` → app, `sign` → sticker views (warn-logged once: 3D ground / sign labels are not drawn natively); `enabled: false` hides all; no `labelsIndex` (same world, as engine-web) | **M2b** (`ground` / `sign` as 3D labels: later) |
| `setLabelContent` | fire-and-forget | `LabelSystem::setContent` | Replaces host content by label id (used with `content: "custom"`) | all entries replaced; applied with `content: "custom"` (labels without an entry keep `nameAndType`) | **M2b** |
| `setUi` | fire-and-forget | `MapSession` → `MapUiState` → platform ornaments; `GameSession` location puck (M3a) | Toggles `locationPuck`, `scaleBar`, `zoomButtons`, `attribution`; `contentInset` (dp) shrinks the *visible area* the camera, the ornaments, the labels and `camera:idle` are measured against | replaces the spec; scale bar, zoom buttons (+ compass) and attribution text (+ MapLibre logo / attribution button) drawn from core-computed values (§2.1); `locationPuck` = puck layers under the player (§2.2); `contentInset` fully applied (§11.1): the camera centre and `follow` centring land in the middle of the visible area (`MapSession::insetShiftFor`), `fitBounds` adds it to its padding, both platform views lay every ornament out inside the visible area (`MapUiState::inset`, including MapLibre's logo / attribution button / compass), labels and markers are placed and clamped inside it, `camera:idle` measures it and `ScreenPoint.visible` means "inside the visible area" | M2a, **M3a** (puck), **M5** (`contentInset`) |
| `setCamera` | fire-and-forget | `CameraController::setCamera` → `mbgl::Map::jumpTo/easeTo` | Merges unset fields; `distance` wins over `zoom`; `follow` locks target; `animate` duration | `MapSession::setCamera`: merge, distance clamped to 14–150 world units, pitch to 0–60°, `animate` (`true` = 600 ms); `follow` through `GameSession` (§2.2): unknown id → `error{unknown_character}` and nothing applied, `null` / `center` without `follow` / user pan stop following, the camera eases towards the character every tick (after a running animation) | M1, **M3a** (`follow`) |
| `upsertCharacters` | fire-and-forget | `GameSession` (§2.2) | Upserts by id, merging into the existing character (absent fields keep their value); async cgltf load; `error{model_load_failed}` on failure; default avatar otherwise. `null` restores a field's default: `model` (default avatar again), `name` (tag shows the id), `color` (default player/NPC color, procedural body rebuilt), `follow` (not location-driven), `isPlayer` (`false`), `scale` (1), `animations` (automatic clip matching), `showNameTag` (`false`, tag removed); `id`/`position` are not nullable | merge / `null` semantics and engine-web spawn points; more than one player → `error{invalid_character}`; glTF / GLB models loaded off the engine lock and drawn skinned in the custom layer (clips by `animations` / conventional names, cadence, 150 ms cross-fades), the procedural body while loading / without a model / after `error{model_load_failed}` (M3b, §6.4); `showNameTag` draws the name tag as a label view (engine-web `nameTagAnchor`, §6.5) | **M3a**, **M3b** (glTF), **M2b** (name tags) |
| `removeCharacters` | fire-and-forget | `GameSession` (`TravelTrips::cancel`) | Removes characters; running travels emit `travel:cancel` | as engine-web (also stops following the character) | **M3a** |
| `setLocationSource` | fire-and-forget | `GameSession` (`LocationService`) + `MapAdapter::startLocationUpdates` | `device` starts GPS (main thread), `external` waits for `pushLocation`, `simulated` runs the demo loop | as engine-web; device failures → `error{location_unavailable}` | **M3a** |
| `pushLocation` | fire-and-forget | `GameSession` (`LocationService::push`) | Smoothed fix for the player (effective with `external`) | smoothed, drives `follow: "location"` characters along the roads | **M3a** |
| `travel` | fire-and-forget (answered by events) | `GameSession` (`TravelTrips::start`, `planLegs`) | Cancels any previous travel (`travel:cancel`), expands legs, emits `travel:start`, then `travel:progress` (subscribed) and `travel:arrive`. Moves at real-world speed per mode (`KMH / 3.6 / unitMeters` world units/s) × optional `timeScale` (finite, > 0, default 1); `travel:progress.etaSeconds` is wall-clock time at that scale (real ETA / `timeScale`) and `character:position.speedMps` the on-map ground speed, while the `route` request keeps unscaled real-world ETAs | as engine-web: `error{not_ready}` without a world, `error{unknown_character}`; the player's route drawn as line + pin layers | **M3a** |
| `cancelTravel` | fire-and-forget | `GameSession` (`TravelTrips::cancel`) | Emits `travel:cancel` if a travel was running | as engine-web (`error{unknown_character}`) | **M3a** |
| `setDropLayer` | fire-and-forget | `GameSession` (`DropCollector::setLayer`) | Replaces the layer; builds instance buffers; collection radius and collectors | kept until a world loads; 3D items in the custom layer (coin / gem, CD, LP, note, glTF `model` drops; appear, bob, spin, collect pop, rarity beam + ring; §6.3); a failed model shows a coin and emits `error{model_load_failed}` | **M3a**, **M3b** (3D) |
| `removeDropLayer` | fire-and-forget | `GameSession` (`DropCollector::removeLayer`) | Removes the layer and its instances | as engine-web | **M3a** |
| `setGeofences` | fire-and-forget | `GameSession` (`GeofenceTracker::set`) | Replaces all geofences; membership of unchanged ids preserved; removed ones are forgotten silently (no `exit`) | as engine-web; fill + ring layers | **M3a** |
| `setBuildingStyle` | fire-and-forget | `MapSession` building overrides → extrusion paint (M2a) + custom building layer (M2c) | Per-building color, roof, facade, decorations, massing, `replaceModel` (glTF), `state`; `null` clears | `color` and `state: "captured"` (glow mix + accent ring) as data-driven extrusion paint (§2.1); `roof` (gable / dome on rectangles), `facade` and the captured flag in the custom building layer (M2c); `null` clears; decorations / massing / replaceModel warn-logged once; `error{unknown_building}` / `error{not_ready}` as engine-web | M2a (color, state), M2c (roof, facade, captured flag), M4 (decorations, massing, replaceModel) |
| `setOverlayAnchors` | fire-and-forget | `MapSession` overlay anchors → `MapAdapter::projectPoints` | Emits `overlay:positions` while anchors exist and the view changes | one `projectPoints` batch per 16 ms frame while anchors exist and the camera / viewport / anchors change (§2.1) | M2a |
| `subscribe` | fire-and-forget | `SubscriptionRegistry` (`MapSession` for `camera:change` and `camera:idle`, `GameSession` for the rest) | Topic × optional id × `throttleMs`; samples the characters / camera / trips each tick | `camera:change` emitted once on subscribe, then throttled; `character:position` (on change) and `travel:progress` throttled per subscription and key (§2.2); `camera:idle` arms one event on subscribe and then fires 150 ms after each rest (id ignored, like `camera:change`) | M1 (`camera:change`), **M3a**, **M5** (`camera:idle`) |
| `unsubscribe` | fire-and-forget | `SubscriptionRegistry` | Removes the subscription with the same topic and id | `camera:change` and `camera:idle` removed (id ignored, as engine-web); other topics by id | M1 (`camera:change`), **M3a**, **M5** (`camera:idle`) |
| `request` | request → `response` | `project`, `unproject`, `fitBounds` → `MapSession` (adapter / `camera_math`); `snapToRoad`, `route` → `GameSession` (`RoadGraph`, `planLegs`); `focusOn`, `snapToBuilding` → not built yet (`engine-web` frames `focusOn` with `core/fit-bounds.ts` and answers `snapToBuilding` from `labels/anchor.ts`) | Always answered with exactly one `response` (same `requestId`); failures use `ok: false` | `project` / `unproject` answered asynchronously through the adapter (`ok: false`, `not_ready` without an attached, laid-out view or when it detaches); `snapToRoad` / `route` answered synchronously (`not_ready` without a world); `fitBounds` answered synchronously from `camera_math::fitBounds` (a port of engine-web `core/fit-bounds.ts`, fixture-compared), moves the camera through the same path as `setCamera` and reports `fitted` / `distanceLimited` (`not_ready` without a world or a laid-out view); `focusOn` is decoded and validated (including "exactly one of `coordinate` / `infoCardId`") and then answered `ok: false` with `unsupported`; `snapToBuilding` (the building a coordinate falls in, or the nearest one within `maxDistanceMeters`) is likewise decoded and answered `unsupported` — the footprint lookup is a port of engine-web `labels/anchor.ts` and is not written yet | M1 (`project`, `unproject`), **M3a** (`snapToRoad`, `route`), **M4** (`fitBounds`), **M5** (`focusOn`, `snapToBuilding`, protocol only) |
| `setMarkerLayer` | fire-and-forget | `MapSession` → `MarkerSystem` → the label view pool (§6.9) | Replaces the layer's markers (matched by `id`), its `selectedId`, `selectedScale`, `size` and `anchor`. Markers are fixed-size screen pins placed before the labels: `alwaysVisible` markers and the selected one are never hidden, the rest lose collisions by `priority` (higher wins), then camera-target distance. A changed `color` / `selectedId` must not reload an icon or recreate a view. | drawn as cards of the same `LabelFrame` the labels use, so markers get recycled native views, accessibility elements and one collision pass shared with the labels (§6.9); placement, forced markers, anchors, `selectedScale` and the 2 dp box padding are engine-web's (`markers.ts`, port-tested); `MarkerStats` proves that a colour / selection change creates no view and loads no icon | **M5** |
| `removeMarkerLayer` | fire-and-forget | `MarkerSystem` | Removes the layer and recycles its views | as engine-web (the views go back to the pool, nothing stays pressable) | **M5** |
| `setInfoCard` | fire-and-forget | info cards (not built yet; `engine-web` draws them as DOM cards in the label layer) | Creates or replaces **one** card, keyed by `card.id`: coordinate, `anchor` (`ground` / `roof` / `auto`), `heightMeters` and the structured `content` (title, subtitle, place icon, badges, rating, rows, actions). Several cards can be on screen; a card wins every collision and registers its own box as an exclusion for the markers and labels. The engine never opens a card by itself. | decoded and validated, then warn-logged and ignored (`Dispatcher::ignoreNotImplemented`) | **M5** (native info-card views) |
| `removeInfoCard` | fire-and-forget | info cards | Removes the card with this id (unknown ids are ignored) | decoded and validated, then warn-logged and ignored | **M5** |
| `setView` | fire-and-forget | view mode (not built yet; `engine-web` draws the flat view with `render/flat-buildings.ts` and `render/view-mode.ts`) | Switches the render view mode between `2.5d` (the tilted diorama) and `2d` (a flat map: filled footprints with an outline instead of extruded buildings, no shadow pass, no distance fog, no street clutter, anchors flattened to the ground, pitch pinned at 0 and locked against gestures). `animate` (default `true`) interpolates the building height and the pitch over `VIEW_TRANSITION_MS`; a second `setView` retargets from the current flatness. The engine never changes the mode by itself. | decoded and validated, then warn-logged and ignored (`Dispatcher::ignoreNotImplemented`) | **M5** (native flat view) |
<!-- protocol-commands:end -->

### 5.2 Events (engine → host) — all 20 `ENGINE_EVENT_TYPES`

<!-- protocol-events:start -->
| Event | Emitted by | Trigger | Delivery | Current (M1) | Full in |
| --- | --- | --- | --- | --- | --- |
| `ready` | `Engine::start` → `Dispatcher::emitReady` | Engine created and sink attached | Once; `engine.kind = "native"` | emitted | M0 |
| `error` | `Dispatcher` (`invalid_message`), world loader (`world_load_failed`), game session (`not_ready`, `unknown_character`, `invalid_character`, `location_unavailable`, `internal`), `model_load_failed` (M3b) | Decode failure, load failure, unexpected failure | Immediate (next batch) | `invalid_message`, `world_load_failed`, `unsupported`; `unknown_building` / `not_ready` from `setBuildingStyle`; the M3a game codes (§2.2); `model_load_failed` (engine-web's messages `character <id>: failed to load <uri>: <reason>`, `drop <layer>/<id>: …`) | M0 / **M3a** / **M3b** |
| `labelsIndex` | `MapSession` → `LabelSystem::setWorld` (`buildLabelEntries`) | After every successful world load | Once per load | emitted with engine-web's ids and payload (fixture-tested on the Seongsu sample: 78 labels) | **M2b** |
| `map:press` | `MapSession::tap` → `MapAdapter::queryBuilding` | Tap whose ray hits the ground and no building | Immediate (after the platform query) | emitted (ground coordinate under the tap) | M2a |
| `building:press` | `MapSession::tap` → rendered-feature query of the extrusion layer (M2a; the custom layer has no picking hook, roofs above the walls are not pickable) | Tap on an extruded or replaced building | Immediate (after the platform query) | emitted (ground point on the footprint, else its centroid) | M2a |
| `drop:collect` | `GameSession` tick (`DropCollector::check`) | Collector within `collectRadiusMeters` (squared distance in flat world units); UUID v4 nonce from `std::random_device` | Immediate; drop marked collected first (never twice), then its marker pops | emitted | **M3a** |
| `travel:start` | `GameSession::travel` (`TravelTrips::start`) | Accepted `travel` | Immediate, before any progress | emitted | **M3a** |
| `travel:progress` | `GameSession` tick (`TravelTrips::progress`) | Topic `travel:progress` subscribed | Throttled (`throttleMs`) per subscription and character | emitted | **M3a** |
| `travel:arrive` | `GameSession` tick (`Follower::stepCharacter` → `TravelTrips::arrived`) | Destination reached (a trip without legs arrives at once) | Immediate | emitted | **M3a** |
| `travel:cancel` | `TravelTrips::start` / `cancel` / `cancelAll`, `removeCharacters`, world load | Superseded, cancelled, character removed or new world | Immediate | emitted | **M3a** |
| `geofence:enter` | `GameSession` tick (`GeofenceTracker::update`) | Character's ground distance becomes < radius | Immediate | emitted | **M3a** |
| `geofence:exit` | `GameSession` tick (`GeofenceTracker::update`) | Character leaves a geofence (removed geofences / characters are forgotten silently, as engine-web) | Immediate | emitted | **M3a** |
| `character:position` | `GameSession` tick | Topic subscribed (optionally per id); on position / heading / speed change | Throttled per subscription and character | emitted | **M3a** |
| `camera:change` | `SubscriptionRegistry` sampling `CameraController::state` | Topic subscribed and camera changed | Throttled | emitted by `MapSession` (after a world load; gestures, animations and `setCamera`) | M1 |
| `overlay:positions` | `MapSession` (`projectPoints` replies) | Anchors exist and the view or anchors changed | At most once per frame (16 ms) | emitted | M2a |
| `response` | `Dispatcher` (per request method handler) | Every `request` | Exactly once per `requestId` | `project` / `unproject` results; `snapToRoad` / `route` results (M3a); `not_ready` | M1 / **M3a** |
| `marker:press` | `MapSession::tap` → `MarkerSystem::hitTest` (and VoiceOver / TalkBack activation of a marker card, which reports a press at the card) | A press hits a visible marker | Immediate; takes precedence over `building:press` and `map:press`, which are then not emitted for the same press | emitted: the hit test runs before the building query, so a marker press is the only event; the hit box is the visual box grown to at least 44 dp (§6.9) | **M5** |
| `camera:idle` | `MapSession::pumpCameraIdle` (`SubscriptionRegistry` + the idle deadline armed by `cameraChanged`) | Topic subscribed and the camera has been still for `CAMERA_IDLE_DELAY_MS` (150 ms); `subscribe` arms one event | Once per rest, then floored by `throttleMs` | emitted: `camera` (the resting state), `bounds` and `radiusMeters` from `camera_math::visibleGroundCorners` (visible area, clamped to 6 × `distance`), `reason` latched at the last change (`api` for `setCamera` / `fitBounds`, `follow` for `setCamera.follow`, `gesture` for everything else **including the zoom buttons**). Honours `ui.contentInset`. | **M5** |
| `infoCard:press` | info cards (`engine-web`: a click on the card's DOM, which captures its own touches) | The card body or one of its `content.actions` buttons was pressed | Immediate; `actionId` present only for an action button. Takes precedence over `building:press` / `map:press`, which are not emitted for the same press | not emitted yet (no native info-card views) | **M5** |
| `infoCard:dismiss` | info cards (`engine-web`: the close button of a `dismissible` card) | The close button was pressed | Immediate; the engine does **not** remove the card — the host sends `removeInfoCard` | not emitted yet | **M5** |
| `view:change` | the view controller (`engine-web`: `render/view-mode.ts`) | A `setView` (or `init.view`) changed the mode, or a view transition settled | Twice per animated switch (`animating: true` at the start, `animating: false` when it lands) and once for an instant switch or a `setView` for the mode the engine is already in; `view` is always the mode being moved **to** | not emitted yet (no native flat view) | **M5** |
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
- The collection test runs on the core thread with engine-web's rule: squared ground distance in flat world
  units against `(collectRadiusMeters / unitMeters)²` for every allowed collector [V: `cpp/src/DropLogic.cpp`,
  `drops.json` conformance] (no haversine; a broad-phase grid can come with the instanced renderer if drop
  counts need it). A collected drop is marked collected before `drop:collect` is emitted (then its item pops).

**M3b (implemented, `ModelLayer.cpp`, `ProceduralMeshes.cpp`).** Each drop is an item of engine-web's `DropVisuals`
[V: `m3b_drop_item_transforms_and_frames`]: gold coin (a gem octahedron when `value ≥ 50`), CD / LP discs
(the canvas label textures become vertex-coloured rings with the same radii and colours, spindle hole open),
the extruded note (without its bevel) in the rarity colour, `model` drops as their glTF normalized to 1.1 by the
largest extent (nothing while loading, a coin after a failed load). Animation as engine-web: appear
(`easeOutBack` over 0.35 s), idle bob (`sin(3t + phase) · 0.12`, music items `sin(2.4t + phase) · 0.1`, 0.05
higher) and spin (2.2 / 1.6 rad/s), collect pop over **0.45 s** (grows `1 + 1.5k`, then shrinks `1.6(1 − k)/0.6`,
rises 5 units/s, spins 14 rad/s; M3a's circle popped for 300 ms), and for music drops or rare / legendary
rarities the additive beam (open cone, 1.5× for legendary, collapses during the pop) and glow ring (a vertex-alpha
disc instead of the glow texture). The orbiting note sprites, the "+value" text and the chime are not drawn.
The core computes the item transforms per tick (a few µs per drop) and batches every rigid item mesh into one
instanced draw per mesh with the identity palette, so 1,500 drops cost ≈ 10 draws; moving the animation into
the vertex shader (the plan above) remains an option if drop counts grow.

### 6.4 Skinned glTF characters, and why the core has its own JSON

- **Loader: cgltf** (MIT, single header) on a worker thread. It parses GLB/glTF 2.0 and resolves buffers, and
  `asset://` URIs go through platform services. Meshes are converted to the engine vertex format
  (position, normal, uv, joints ×4, weights ×4). Textures are decoded with the platform decoder (ImageIO /
  BitmapFactory) and transcoded to ASTC off-thread when the file has none.
- **Skinning renderer.** GPU linear-blend skinning: a joint palette of ≤ 64 joints per character in a
  uniform buffer, and ≤ 4 influences per vertex. An animation state machine (`idle`, `walk`, `run`,
  `ride`, `wave`, mapped through `CharacterSpec.animations`) samples channels on the core thread and writes
  the joint matrices into the frame snapshot. Cross-fades take 150 ms.
- **M3b (implemented).** `GltfLoader.cpp` (cgltf v1.15) reads GLB and glTF with `data:` / relative / http(s)
  buffers and images (fetched through `MapAdapter::fetchBinary`, parsed again with them), rejects Draco and
  meshopt geometry (`KHR_draco_mesh_compression`, `EXT_/KHR_meshopt_compression` required) and models needing more
  than 63 joints, and converts every triangle primitive to the 36-byte `ModelVertex` (position, snorm normal with
  an unlit flag for `KHR_materials_unlit`, uv, sRGB colour = linear base colour factor × vertex colour, 4 joints,
  4 unorm8 weights summing to 255). **One palette per model** unifies the two kinds of glTF animation: entry 0 is
  the identity (static geometry baked into model space), each rigidly animated mesh node gets an entry with an
  identity inverse bind matrix (the example robot: 8 entries), each skin joint `global(joint) × inverseBind`;
  the GPU skins every vertex with ≤ 4 influences, so node-animated and skinned models share one shader.
  Base colour textures (PNG / JPEG) are decoded by ImageIO / BitmapFactory on the worker (RGBA8, no mipmaps, no
  ASTC transcoding yet); alpha `MASK` discards, `BLEND` goes to the blended pass. Morph targets, cameras, lights
  and other material maps are ignored. `ModelLibrary` shares loaded models by URI and, like engine-web's
  `gltfCache`, retries a failed URI on the next request.
- **Animation (M3b).** `CharacterAnimation.cpp` ports `resolveClips`, `chooseAnimation`, `walkCadence`,
  `clipTimeScale` and `headingFromYaw` [V: `characters.json`, 2,580 cases] and samples TRS channels like three.js'
  interpolants (linear with slerp, step, cubic spline). **Cadence is measured on the map, not on screen**: it is the
  ground the character covers in metres per wall-clock second (`speed × unitMeters`, engine-web `realSpeedMps`) over
  the natural walking pace (`KMH.walk`, 4.8 km/h) times the character `scale`, clamped to [0.5, 2.2], with `run`
  above 1.6. So a character travelling at real-world speed plays its walk clip at 1× at every `unitMeters` and its
  feet stay planted, and a travel `timeScale` of 20 covers twenty times the ground and reads as a run at the cap.
  `ModelAnimator` ports the part of `AnimationMixer` engine-web uses (looping actions, `crossFadeTo` / `fadeIn` /
  `fadeOut`, per-action time scale, weighted accumulation with the rest pose filling the missing weight) and is
  checked frame by frame against three.js driving the example robot through idle → a real-time walk (cadence 1) →
  idle → twice that pace (the `run` chain) with **150 ms** cross-fades (engine-web uses
  0.25 s) [V: `m3b_model_animator_crossfade_matches_three`, max 2.7e-8]; node matrices and a generated skinned
  model's `skeleton.boneMatrices` match three.js within 1.7e-8 / 5.6e-8 [V: `m3b_gltf_loader_sample_robot_matches_three`,
  `m3b_skinning_palette_matches_three`]. glTF characters are normalized like engine-web (`CHARACTER_HEIGHT` 1.9 ×
  `scale`, feet at 0, centred), rotate with the smoothed heading and sit on the bike (0.32 up, 0.17 back).
- **Procedural body and vehicles (M3b).** Without a model (and while one loads, or after a failure) the character
  is engine-web's procedural body (`geos()`: lathe torso, head, hair or the player's cap + backpack, capsule limbs,
  unlit eyes) as a 9-joint rigid mesh per (colour, player), animated by the port of `Character.animate`'s
  procedural branch (walk / run swing by cadence, idle breathing, pedalling). The four vehicles of `vehicles.ts`
  are ported whole (bike with spoked wheels and crank, extruded car with windows, lights and driver, plane with
  propeller and pitch, translucent subway ghost train) with pop-in (`easeOutBack` 0.35 s), wheel spin, propeller,
  car bob and engine-web's `hideBody` / `onBike` rules. Not drawn: ink outline hulls, silhouettes of characters
  behind buildings (the custom layer draws before the extrusions, so there is no "behind" pass; characters are
  simply occluded) and `wave`; name tags are label views (§6.5).
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

**Original decision (fork plan).** GPU quads rendered by `MapramaLayer` for every style, consistent with
engine-web's three.js sprites, with a small pool of invisible native accessibility elements.

**M2b decision (official SDKs, implemented).** Native views, because the official SDKs have no glyph pipeline
for a custom layer and the label counts on screen are small (engine-web's own rules cap them: ≤ 5 road holo
cards, collision culling). The split keeps the adapters thin:

- **Core (`cpp/include/maprama/LabelSystem.hpp`).** A port of engine-web's pure label rules
  (`packages/engine-web/src/labels/index.ts`): `buildLabelEntries` (ids `district:<name>[#n]`,
  `road:<id>:<k>` anchors every 42 units from 16 units along named non-alley non-bridge roads with a 30-unit
  same-name dedupe, `poi:<id>`; priorities, icons, subtitles), `resolveLabelContent` (content modes),
  `holoEligible` / `domLabelVisible`, greedy `placeHolo` (priority, then target distance, ≤ 5 roads) and the
  app-style greedy pass (priority order, rotated boxes, upright road angles), `clampLabelX` (6 dp edge margin;
  the holo dot and leader line keep the true anchor) and HUD exclusion zones (engine-web's status / bottom
  strips plus the native ornaments' actual frames: zoom buttons, compass, scale bar, logo, attribution).
  Anchors are projected by `MapProjector`, a port of MapLibre's perspective (512-dp tiles, 36.87° field of
  view, camera `0.5·height / tan(fov/2)` dp from the centre; heights at the centre's ground scale), so holo
  cards float `HOLO_HEIGHT` world units above the ground (district 7, POI 3.6, road 2.8) exactly like
  engine-web. Conformance: `labels.json` is exported from engine-web's own `src/labels/*.ts` (transpiled by
  `scripts/web-labels.mjs`, engine-web unchanged): entries + `labelsIndex` of seven worlds (Seongsu: 78; the
  generated town seeds 42 / 7: 87 each, grid seed 7: 47),
  every content mode, HUD boxes, 60 random holo placement sets, and the visibility / clamp / rotation /
  upright / tile rules [V: `label_tests.cpp`].
- **Platform (`ios/MapramaLabelLayer.mm`, `android/…/MapramaLabelLayer.kt`).** Draws the frame's cards with
  recycled views keyed by label id and measures cards for the core. Looks follow engine-web's stylesheet
  (`dom-styles.ts`): `holo` = ground dot with a pulsing ring, gradient leader line and a glass card (iOS:
  backdrop blur material + tint; Android: a denser gradient, no backdrop blur) with the icon tile
  (`white` / `black` / `color`, `auto` = black at night); `app` / `minimal` / `clean` / `sticker` = text with
  halos, POI badges, pills. Pop-in (dot → line → card) is skipped under reduced motion. System fonts are used
  (engine-web's IBM Plex Sans KR / Jua are not bundled; `sticker` uses the rounded system design on iOS).
  Each visible card is an accessibility element labelled "name, type" with the id `maprama-label-<label id>`.
- **Frame order.** A placement runs on whichever thread caused it: a camera report and a measurement reply arrive
  on the main thread (applied in the same run-loop turn, so the cards move with the map), a command or a game tick
  on the JS thread (posted to the main thread). A posted frame can therefore land after a newer one that was
  applied inline, which would leave the older placement on screen — `LabelFrame::sequence` increases with every
  frame the core sends and both layers ignore anything that is not newer [V: `label_tests.cpp`]. Without it,
  switching the content mode wiped every card: the empty frame computed while the new card sizes were being
  measured arrived after the frame that placed them again.
- **Icons.** `scripts/generate-label-icons.mjs` converts engine-web's `HOLO_ICONS` / `POI_GLYPHS` SVGs into
  vector shapes (move / line / cubic / close, arcs converted to cubics) with fill / stroke roles
  (`currentColor`, accent `var(--c)`, white), plus `ICON_COLORS` and the default subtitles, into
  `cpp/src/LabelIcons.cpp`; `npm test` fails when it drifts from engine-web. Both platforms replay the shapes
  into `CGPath` / `android.graphics.Path` (crisp at any scale, tinted per tile) — no PNGs.
- **Procedural worlds.** Generated worlds go through the WorldData path (§6.8), so their districts, named roads and
  POIs are labelled by the same `buildLabelEntries`; the index is fixture-compared with engine-web's own
  `buildLabelEntries` of `buildTownWorld` / `buildGridWorld` (town 42 / 7, grid 7), and holo ground dots sit at
  engine-web's `groundYFor(kind)` (0.05 on the grid, 0.09 elsewhere) [V: `label_tests.cpp`].
- **Character name tags.** `GameSession` sends every tick the anchors of the `showNameTag` characters
  (`MapSession::setNameTags`): engine-web's `nameTagAnchor` (2.3 · scale above the root, 2.0 in a car, over the
  plane's tail fin and the subway ghost train's middle car once the vehicle has popped in past 0.55), the text
  (`name`, else the id) and the player's colour. The label system projects them with the labels: hidden 95+ world
  units from the camera eye, from a 0.6 zoom-out factor on and over a HUD zone (engine-web `updateTags`); cards
  `tag:<id>` after the labels (drawn on top), shown whatever the label style (also with labels off), accessibility
  label = the name. Look = engine-web `.mpr-tag` (white pill with a 1.5 dp ink border, the player's filled with its
  colour, default #2F5BEA; system rounded bold instead of Jua). A game tick re-places only the tags: the label
  layout of the last camera change is reused.
- **Zoom-out rules.** The zoom-out factor is engine-web's `zoomOutTarget` (`smooth01((d − 55) / 55)` of the camera
  distance in world units, 0 for `zoomOut: "none"`), used without engine-web's `dt · 6` easing (the distance itself
  moves smoothly): app-style district labels show from 0.2 and fade in (`min(1, 0.45 + zoomOut)`), name tags
  hide from 0.6. Holo labels have no zoom-out rule in engine-web.
- **Not done.** `ground` and `sign` 3D labels (drawn as `app` / `sticker` views), labels occluded by buildings
  (views are never depth-tested).

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
- **Zoom-out game view (M4, implemented).** `cpp/src/ZoomOut.cpp` ports engine-web's `render/zoom-out.ts`
  exactly: the factor `t` eases at 6/s towards `smooth01(clamp((distance − D1) / D1))` with **D1 = 55** and
  **D2 = 110 world units** (engine-web's own band; the camera range is 14–150), and the look is re-applied when
  `t` moved by more than 0.003 [V: `zoom-out.json` fixture — `zoomOutTarget` samples and 9 controller traces
  driven through the real `ZoomOutController` with recording targets; `m4_zoom_out_target_matches_engine_web`,
  `m4_zoom_out_controller_matches_engine_web`, agreement within 1e-12]. `MapSession` steps it in its own 16 ms
  frames while it eases (engine-web steps it in every rendered frame) and stops asking for frames once it rests.
  - `none` keeps the diorama at every distance (`t = 0`).
  - `mapColors` fades engine-web's flat map-colour overlay in to 92 % (`MAP_COLORS` over the world pad, parks,
    water and the roads by class with the arterial casing, as MapLibre style layers inserted above the themed
    ground and below the POI discs) and shrinks the buildings to 40 % height: the `fill-extrusion-height`
    expression and the custom layer's `heightScale` uniform (which scales the roofs, facades and outlines with
    the walls) both follow engine-web's `scaleY = 1 − 0.6 t`.
  - `keepGameView` keeps heights and colours, as on the web.
  - Both non-`none` behaviours simplify the distance the way engine-web hides its street clutter (`t ≥ 0.5`,
    i.e. beyond ≈ 82 world units): the custom layer switches to its **low-detail index range** — the same
    vertices, without facade details and roof furniture (`BuildingLayerData::lowDetailIndices`, ≈ 8 % fewer
    triangles for Seongsu with `modern`, 22 % with `details: true`) — and beyond **D2** characters and drops
    become **icon discs**: one instanced draw for all of them (ground discs in the body / rarity colour with a
    dark rim, `iconDiscMesh`), with hysteresis at 0.95 · D2. Both are deliberate differences from engine-web,
    which keeps its facade details, roof furniture and 3D models at every distance and instead hides the street
    clutter the native engine never had (§11); at 1,150 m the dropped roof furniture (solar panels, HVAC) is
    visible when the behaviour is switched between `none` and `keepGameView` side by side.
  - Fog, the shadow camera and the haze overlay of engine-web's controller are computed and conformance-tested
    but not drawn: the native engine has no fog, shadow or post pass yet (§6.6).
  - Labels are **pending** (M2b, not merged yet): engine-web hides road / POI labels and fades district labels in
    with the same factor (`domLabelVisible`, opacity `min(1, 0.45 + t)`) and hides character name tags above
    `t ≥ 0.6`. The factor is exposed to the label system through `MapSession::zoomOut()` when labels land.

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

### 6.9 App markers (M5)

`setMarkerLayer` draws app-owned pins. **Owner decision: markers reuse the label view pool** — a marker is a
card of the same `LabelFrame` the labels are drawn from, so it gets a recycled native view, an accessibility
element and one shared collision pass instead of a second renderer. The core owns everything but the
drawing: `MarkerSystem` (`cpp/src/MarkerSystem.cpp`) is a port of engine-web's `src/labels/markers.ts`.

- **Placement** runs once per frame, *before* the labels, and in engine-web's order: HUD zones (status strip,
  ornaments, content inset) first; then the **forced** markers (`alwaysVisible`, plus the layer's
  `selectedId`), which are never dropped; then the rest by `priority` (higher first), camera-target distance
  and key. The boxes of the shown markers go to the label pass as extra exclusions, so a label never covers a
  marker. Boxes are the visual size padded by 2 dp, as on the web.
- **Geometry.** Fixed screen size in dp (`size`, default 36), anchored `bottom` by default so the pin tip sits
  on the coordinate, `center` / `top` supported; the selected marker's card is `selectedScale` (default 1.25)
  larger, and the core hands the platform the already-scaled size.
- **Partial updates.** A `setMarkerLayer` that only changes `color` or `selectedId` keeps every marker's
  `LabelCardContent::key` (`mk|<shape>|<uri>`), which is the *only* thing the platform layers rebuild on — so
  no view is recreated and no icon is decoded again; the tint and the selected look are a handful of property
  writes per frame. `MarkerStats` (`Engine::markerStats`) counts both the way engine-web's `MarkerLayers.stats`
  does, and `cpp/tests/marker_tests.cpp` asserts on it at the system level and end to end through the session.
- **Icons.** `icon: "pin" | "dot" | { uri }`, as on the web. The base shapes come from the core
  (`markerBaseShape`, the same curves as engine-web's `SHAPES` SVGs) so both platforms draw the same pin, and
  a custom image is drawn inside it (centred, 14 % down, 46 % wide, engine-web's `.mpr-mk-img`). Neither
  `UIImage` nor `BitmapFactory` can decode SVG, and the web engine's icons are SVG, so the core parses the
  subset those icons use (`MarkerIcons.hpp`: `<path>`, `<circle>`, `<ellipse>`, `<rect>`, `<polygon>`,
  `<polyline>`, `<line>`, hex / named / `currentColor` paints) and each platform replays it once into a cached
  image. The parser **fails closed** — arcs, gradients, transforms and groups make it return nothing and the
  marker then shows its plain base shape. Raster `data:` URIs go to the platform decoder; `http(s):` / `file:`
  icons are fetched on a background thread and cached by uri. `currentColor` follows the marker tint, as in
  engine-web's `color: var(--mk)`.
- **Presses.** `MapSession::tap` hit-tests the markers **before** the building query, so a press that hits a
  marker emits `marker:press {layerId, markerId, coordinate, point}` and nothing else — engine-web's rule.
  `point` is the marker's anchor on screen (the pin tip for `bottom`). Placement order is hit-test order, so
  the higher-priority marker wins where two boxes overlap. **Deviation from engine-web, deliberate:** the hit
  box is the visual box grown to at least 44 dp on each axis, because a 36 dp pin is below both platforms'
  minimum touch target. Label cards are not pressable on either engine, and a shown marker always reserves its
  box against the labels, so "who wins when a label and a marker overlap" has one answer: the marker.
- **Accessibility.** A marker card carries `accessibilityLabel` and is exposed as a button (iOS
  `UIAccessibilityTraitButton` + `UIAccessibilityTraitSelected` for the selected one; Android
  `Button` class name, `isSelected`, an `ACTION_CLICK` action). A marker **without** a label is decorative and
  is kept out of the accessibility tree, as engine-web's `aria-hidden` does. Activating a card with VoiceOver
  or TalkBack reports a press at the card, which goes through the same hit test a finger does — the views stay
  non-interactive so panning works from anywhere on the map (engine-web's cards are `pointer-events: none`).

## 7. Tiles

- **Sources.** MapLibre `vector` sources over `https://…/{z}/{x}/{y}.pbf` and **PMTiles** archives
  (`pmtiles://https://…` or `pmtiles://asset://…`) [U: native PMTiles support in the pinned MapLibre
  release; if absent, a patch adds a `PMTilesFileSource` range-request resource loader].
- **Two roles.**
  1. The base map (flat, beyond the diorama).
  2. WorldData carried as vector tiles for large areas, so `init` does not ship multi-megabyte JSON.
     **`WorldSource { kind: "tiles", url, center, … }` now exists** in `@maprama/protocol` and is
     implemented by engine-web (`design/tile-format.md`, MTIL v1). The C++ core validates the command
     with the same schema and **decodes the payload** (`maprama/TileFormat.hpp`, conformance-tested
     against `@maprama/protocol`'s reader in `cpp/tests/tile_tests.cpp`), but nothing streams or draws
     tiles here yet: `init` with `kind: "tiles"` emits `error{unsupported, fatal: true}` naming
     `engine="web"`. The MVT schema below is the **superseded** earlier sketch; the shipped format is
     MTIL over PMTiles, not MVT.
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
20,000 buildings. The targets themselves are still **[E]**: M4 measured the engine on the iOS simulator and the
Android emulator (below), **not** on the reference devices, and not with 20,000 buildings. CI perf gates are
added once device numbers exist.

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

**M3b measurements (models; Seongsu, M3b example screen, simulators).** Taken with a scratch Maestro flow that
switches the screen's crowd between 1, 10 and 50 walking characters (half the example glTF robot — 84 triangles,
8 palette entries — half procedural bodies — ≈ 1,900 triangles, 9 joints; walk ×20 on the roads around the start)
plus 8 drop items (the 6 showcase items and the 2 route drops) for ≈ 16 s each, reading the core's 5 s tick log
and the layer's 240-frame `maprama-frame-stats` (steady-state windows; the camera follows / frames the crowd).

| Characters | Core tick (sim + model frame), avg / max | iOS 26.5 sim (Metal): frame GPU avg / p95, layer encode (models) | Android 15 emulator (GL ES translator): layer render avg / p95 (models) | Frame interval iOS / Android |
| --- | --- | --- | --- | --- |
| 1 | iOS 0.05 / 0.14 ms, Android 0.06–0.07 / 0.8 ms | 0.10 / 0.15 ms, 0.011 ms (0.006 ms) | 0.70–0.85 / 1.3–1.7 ms (0.27–0.35 ms) | 16.7 ms (vsync) / 8–10 ms |
| 10 | iOS 0.09 / 0.47 ms, Android 0.11–0.13 / 0.74 ms | 0.12 / 0.18 ms, 0.012–0.016 ms (0.007–0.010 ms) | 1.0–1.18 / 2.1–2.6 ms (0.48–0.61 ms) | 16.7–17.1 ms / 10–13 ms |
| 50 | iOS 0.19–0.22 / 1.3 ms, Android 0.20–0.21 / 1.8 ms | 0.11–0.12 / 0.15 ms, 0.017–0.021 ms (0.012–0.016 ms) | 1.9–2.0 / 3.7–4.1 ms (1.38–1.45 / 3.0–3.3 ms) | 16.7–17.9 ms / 15.5–16.3 ms |

The same scene on the Mac (`-O2`, the core only: 600 ticks of `Engine::frame` with N characters travelling) costs
0.002 / 0.012 / 0.059 ms per tick for 1 / 10 / 50 characters (50 draws, 8,016 palette floats). One draw per body or
vehicle, the rigid drop items instanced per mesh (the 8 items above take 8 draws). The GPU cost on the iOS
simulator is flat (≈ 0.1 ms for the whole frame); the emulator's GL translation makes its model pass grow ≈ 23 µs
per character. The model frames also keep MapLibre rendering at the display rate while models are on screen
(engine-web's render loop does the same); throttling idle-only animation to 30 fps is an M4 option.

**M4 measurements (performance scene and zoom-out; simulators only — real devices are still unmeasured).**
Scene: the Seongsu data world (428 buildings) with the `modern` preset, **51 characters** (the player's procedural
body, the glTF walker on the simulated source and a 49-character crowd, half glTF robot / half procedural, all
walking ×20), **200 drops**, **20 geofences** and labels pending (M2b), driven by the example's `native-m4` screen:
a near camera (320 m = 40 world units) and a far one (1,150 m = 144 units, beyond D2), each with two 8 s 180°
orbits. Release builds, the same flow before (HEAD = M3b) and after (M4); the layer's `maprama-frame-stats` and the
core's 5 s tick log are the sources, idle gaps > 100 ms excluded.

| | iOS 26.5 simulator (Metal) before → after | Android 15 emulator (GL ES translator) before → after |
| --- | --- | --- |
| Near + orbit: frame interval avg / p95 | 16.7–19.5 / 17.3–33.7 ms → 16.7–17.9 / 17.1–31.8 ms (vsync-bound) | 19.8–24.3 / 23.9–32.7 → 13.9–20.5 / 18.5–30.4 ms |
| Near: layer cost per frame (model pass) | encode 0.032 / 0.033 ms (0.02 ms) → 0.022–0.039 ms (0.018–0.033 ms) | render 3.2–4.3 ms (2.4–2.9 ms) → 1.7–3.0 ms (1.3–2.3 ms) |
| **Far (144 units) + orbit: frame interval avg / p95** | 16.7–19.5 / 17.3–33.4 ms → 16.7–17.2 / 17.0–27.6 ms | **31.7–47.3 / 70.0–87.2 → 8.2–13.1 / 11.5–20.6 ms** |
| **Far: layer cost per frame (model pass)** | encode 0.032 ms (0.02 ms) → **0.008–0.010 ms (0.004 ms)** | render **5.1–10.8 ms (3.5–7.3 ms) → 0.51–0.75 ms (0.09–0.14 ms)** |
| **Far: model draws** | 64 → **1** (icon discs, one instanced draw) | 64 → **1** |
| Whole-frame GPU (iOS command buffer) | 0.11–0.12 / p95 0.14–0.16 ms → 0.08–0.10 / 0.11–0.15 ms | — (no equivalent counter) |
| Core tick avg / max (51 characters, 200 drops) | 0.36–0.38 / 0.51–0.62 ms → 0.16–0.33 / 0.44–0.80 ms | 0.58–6.16 / up to 198 ms → 0.18–0.27 / 1.0–2.4 ms |
| Memory | footprint 146 MB → 106 MB (light) / 140–147 MB (perf scene) | PSS 207–224 MB → 208–219 MB; native heap ≈ 102–104 MB; GL buffers 11.8 MB (meshes) + 1.05 MB (models, 0 with icon discs) |

Against the budgets: the **core tick stays far inside 2 ms** on both (the 198 ms emulator outlier before M4 was a
single stall, gone after); **draw calls** are 2 (building meshes + outlines) + 64 model draws near / 1 far, well
inside 150; **drops** 200 of the 1,500 visible budget; **characters** 51 against a 32-skinned budget, deliberately
over it to see the cost. The **16.6 ms p95 frame** budget is met on the iOS simulator (vsync-bound) but not on the
Android emulator at the near camera (p95 18–30 ms), whose GL translation layer bounds the frame — the same caveat
as M2c/M3b. Memory stays inside the 250 MB budget on both, but neither environment is the reference device.
The M4 zoom-out LOD is what moves the far-camera numbers: the icon discs cut the model pass from 64 draws to 1
(Android: 7× less layer time, ~30× less model time) and the low-detail range removes the facade details and roof
furniture from the building mesh.

**Idle animation and the 30 fps question (M4).** M3b left an open decision: while any character or drop exists, the
core asks for a frame every 16 ms (idle clips, breathing, drop bob / spin), which keeps MapLibre redrawing at the
display rate — engine-web does the same, because its renderer runs `requestAnimationFrame` continuously. Measured
with a scratch flow that parks the app for ~30 s on a screen without models (the M2c `native` screen) and then ~30 s
on the M4 screen with two characters in view (Android emulator, Release, process CPU from `top`, one sample per 8 s):

| Idle window (Android emulator) | process CPU | layer frames |
| --- | --- | --- |
| No characters or drops (no animation frames requested) | **8–24 %** | none (MapLibre redraws on demand only) |
| Two characters in view, idle animation at the frame rate | **112–132 %** | continuous, 12–18 ms interval, layer 0.8–1.5 ms, core tick 0.06–0.09 ms |

The iOS simulator shows the same effect in frames, but not in CPU: with two characters in view the custom layer is
asked to draw every 16.7 ms (encode 0.011 ms, footprint ≈ 106–118 MB), and on a screen with no characters or drops
it is not asked to draw at all (no `maprama-frame-stats` batch appears in that window). The process CPU is
23–28 % in both windows, i.e. the animation disappears in React Native and simulator overhead — unsurprising when
the layer encode is 0.011 ms and the whole frame's GPU time 0.08 ms. The Android emulator, whose GL translation
makes every frame expensive, is where the cost shows.

So the *continuous redraw*, not the core, is what costs battery: the core tick is ~0.07 ms of the ~16 ms frame.
Two changes in M4 remove the cost where it buys nothing, **without changing anything engine-web shows**:
models that are outside the camera's view no longer request animation frames (a conservative frustum test with
engine-web's 40° camera, widened 25 %, plus a 4-unit margin), and the icon discs beyond D2 are static, so a far
camera over a still crowd renders on demand again.

A blanket **30 fps idle throttle was evaluated and not implemented**: engine-web renders visible idle motion
(drop spin 2.2 rad/s, bob, breathing, beams) at the display rate, so halving the rate would visibly differ from the
web engine for anything actually on screen — the lead's condition for adopting it. Its saving would be roughly half
of the redraw cost in the table above (the frame interval doubles; the core tick is negligible either way), i.e. of
the order of 50 percentage points of emulator CPU in the worst case, and it remains available as an opt-in if a
future app-level setting ever asks for it.

Two counters could not be read in these environments: both SDKs report ~0 for their own frame encode / render
times (`mapViewDidFinishRenderingFrame:…frameEncodingTime:`, `OnDidFinishRenderingFrameListener`), and
`MTLDevice.currentAllocatedSize` reads 0 on the simulator, so the iOS memory figure is the process footprint
(`task_info(TASK_VM_INFO).phys_footprint`) and the Android one is `Debug.MemoryInfo` PSS plus the layer's own GL
buffer accounting. Binary size and cold start were not measured in M4.

**M2b measurements (labels and name tags; simulators).** The core logs `label placement` every 5 s of activity
(iOS `os_log` subsystem `dev.maprama.engine` category `core` at info level — `log show --info`; Android logcat tag
`MapramaEngine`). One *pass* is one placement: a full one re-lays out every label, a *name-tag only* pass reuses the
last label layout and re-places just the tags (a game tick does this every 16 ms while tagged characters exist).
At most one pass per frame. Numbers from the Maestro flows (`09-native-labels`, `08-native-m3a`), Seongsu with the
M2c custom building layer and the M3a/M3b markers active.

| Screen | Passes per 5 s | Placement cost avg / max | Cards |
| --- | --- | --- | --- |
| Labels screen, full placements (Android 15 emulator) | 1–4 (camera / command driven) | 0.009–0.125 / 0.341 ms; one window 0.391 / 1.48 ms right after a style + content switch | 5–6 |
| M3a screen, name tags (Android 15 emulator) | 155–170 (≈ all name-tag only) | 0.006–0.008 / 0.024–0.181 ms | 7 |
| M3a screen, name tags (iOS 26.5 simulator) | 305–310 (all name-tag only) | 0.006–0.007 / 0.015–0.033 ms | 7–8 |

Reusing the label layout for tag-only passes is what keeps the game tick cheap: a full pass of the 78 Seongsu
labels costs ≈ 0.1 ms, a tag pass ≈ 0.006 ms. Platform card work (measuring and configuring views) is not in these
numbers: it happens once per content key (`measureLabels`) and on the cards that changed. iOS full-placement
windows were not captured — the labels screen re-places about three times per 90 s, which never filled a 5 s
window during the runs. No device numbers (M4).

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
- **M3b:** cgltf v1.15 is vendored in `cpp/vendor/cgltf` (MIT, root `NOTICE`) and compiled once by
  `cpp/src/GltfLoader.cpp` (warnings of the third-party header suppressed); the podspec adds `ImageIO`; no new
  Android dependency (BitmapFactory, GL ES 3 instancing and uniform blocks).
- Tests: `npm test -w @maprama/engine-native` runs these steps:
  1. export fixtures from the built protocol package (including `resolveTheme` cases);
  2. check DESIGN.md coverage;
  3. check that `cpp/src/ThemeData.cpp` matches the protocol's theme data and `cpp/src/LabelIcons.cpp`
     engine-web's label icons;
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

### 11.1 `ui.contentInset` (M5: complete)

`ui.contentInset` tells the engine that app chrome — a bottom sheet, a side panel — covers part of the map
view. The map keeps drawing across the whole view; what moves is the **visible area** everything else is
measured against. Since M5 the native engine applies it everywhere engine-web does:

| Applied to | Where |
| --- | --- |
| `setCamera` `center` and `follow` centring landing in the middle of the visible area | `MapSession::poseFor` sends the MapLibre camera `centre − insetShift` (`camera_math::insetShift`, a port of engine-web `CameraController.insetShift`); `onCameraChanged` undoes it, so `CameraState.center` still means "under the middle of the visible area" |
| `fitBounds` | the inset is added to the request's padding (`MapSession::fitBounds`) |
| `camera:idle` `bounds` / `radiusMeters` | `camera_math::visibleGroundCorners` |
| Label and marker placement, including the edge clamping | `LabelSystem::nativeHudExclusions` excludes the inset bands and moves the ornament zones; `clampLabelX` clamps into the visible band |
| Ornaments: scale bar, zoom buttons, attribution text, and MapLibre's own logo / attribution button / compass | `MapUiState::inset` → `MapramaNativeView.mm` `layoutOrnaments` + `logoViewMargins` / `attributionButtonMargins` / `compassViewMargins`; `MapramaNativeView.kt` `layoutOrnaments` + `UiSettings.setLogoMargins` / `setAttributionMargins` / `setCompassMargins` |
| `ScreenPoint.visible` (`project`, `overlay:positions`) | `MapSession::onProjected` / `onPointsProjected` test the visible rect |

**Why the camera moves instead of MapLibre's own edge insets.** MapLibre's padding is an off-axis frustum,
not a screen translation, so setting `MLNMapView.contentInset` would put the map and the core's own
`MapProjector` (which projects labels, markers and name tags without a round trip) out of agreement at a
pitch. Moving the camera target by the ground offset between the two centres is exactly what engine-web
does, and it leaves the projection model untouched.

The ornament row is the one that is not cosmetic: the OSM attribution must stay visible (ODbL), so an app
sheet covering the bottom-right corner without an inset is a licence problem, not a layout one.

engine-web status is taken from the v1 plan: it is the shipping engine and implements the full protocol
[U: not re-verified here]. Native columns follow the milestones below.

| Capability | Protocol surface | engine-web | engine-native |
| --- | --- | --- | --- |
| Envelope codec + validation | `decodeCommand` / `encodeEvent` | v1 | **M0** (conformance-tested) |
| Projection | `createProjection` | v1 | **M0** (within 1e-6) |
| WorldData load (`data`) | `init.world` | v1 | **M1** (flat map) |
| WorldData `url` | `init.world` | v1 | **M1** (platform fetch) |
| WorldData `procedural` | `init.world` | v1 | **M2b** (C++ port of the town / grid generators, conformance-tested, §6.8) |
| Camera + gestures | `setCamera`, `camera:change`, `project`/`unproject` | v1 | **M1** (`follow` **M3a**) |
| Subscriptions | `subscribe` / `unsubscribe` | v1 | **M1** `camera:change`; **M3a** other topics; **M5** `camera:idle` |
| Buildings: extrusion, facades, roofs, massing | `setTheme`, `setBuildingStyle` | v1 | **M2a** extrusion, theme colours, colour / captured overrides; **M2c** gable / dome / flat roofs, facade windows + storefronts, facade details, captured flag (custom layer); M4 varied massing, decorations, replaced models |
| Themes + time of day + cinematic | `setTheme` | v1 | **M2a** resolution, colours, light + time-of-day tint; **M2c** outlines, window lights at night; M4 cinematic grading, fog / haze, cross-fade |
| Labels (all styles, custom content) | `setLabels`, `setLabelContent`, `labelsIndex` | v1 | **M2b** `labelsIndex`, content modes, `holo` / `app` / `minimal` / `clean` / `sticker` as native views; character name tags; `ground` / `sign` 3D labels drawn as app / sticker views |
| Map UI | `setUi` | v1 | **M2a** (location puck **M3a**) |
| Presses | `map:press`, `building:press` | v1 | **M2a** (rendered-feature query) |
| Overlay anchors | `setOverlayAnchors`, `overlay:positions` | v1 | **M2a** |
| Characters (glTF skinning) + location sources | `upsertCharacters`, `removeCharacters`, `setLocationSource`, `pushLocation`, `character:position` | v1 | **M3a** all location sources (device feed on both platforms), camera follow; **M3b** glTF characters (GPU skinning, clips, cross-fades), procedural body, vehicles, `model_load_failed`; **M2b** name tags (label views, engine-web anchors); outlines / silhouettes open |
| Travel + routing | `travel`, `cancelTravel`, `travel:*`, `snapToRoad`, `route` | v1 | **M3a** (route line + pin layers) |
| Drops | `setDropLayer`, `removeDropLayer`, `drop:collect` | v1 | **M3a** collection; **M3b** 3D items (instanced), glTF drops, bob / spin / pop, beams + rings; note sprites, "+value" text, chime open |
| Geofences | `setGeofences`, `geofence:*` | v1 | **M3a** (fill + ring layers; no pulse) |
| Zoom-out game view | `theme.zoomOut` | v1 | **M4** (`zoomOutTarget` / controller conformance-tested against engine-web; `mapColors` overlay + 40 % heights, low-detail custom layer, icon discs beyond D2; fog / shadows / haze not drawn, labels pending) |
| PMTiles / tile-backed WorldData | (protocol addition) | planned | planned (same release as web) |

**Remaining differences to engine-web (M4 parity pass).** Walked row by row with both engines rendering the same
scene through the example's engine toggle (`example/app/native-m4.tsx`, Maestro `10-native-m4`), on the iOS
simulator and the Android emulator:

| Area | Difference | Why / where |
| --- | --- | --- |
| Labels and name tags | Not drawn at all (no `labelsIndex`, `setLabels`, `setLabelContent`, no character name tags, none of engine-web's zoom-out label rules) | **M2b, not merged yet** — the one capability still missing for beta |
| Zoom-out (§6.7) | Beyond D2 characters and drops are icon discs; engine-web keeps its 3D models at every distance | Deliberate: one instanced draw instead of one per character (§8 measurements below) |
| Zoom-out (§6.7) | From `t ≥ 0.5` the custom layer drops facade details and roof furniture; engine-web keeps them (it hides street clutter instead, which the native engine does not draw) | Deliberate: the low-detail index range; visible at 1,150 m when switching `none` ↔ `keepGameView` |
| Zoom-out (§6.7) | Fog and shadow ranges and the haze overlay are computed (and conformance-tested) but not drawn | The native engine has no fog, shadow or post pass yet (§6.6) |
| Reduced motion | The OS "reduce motion" setting is not read; engine-web snaps the zoom-out factor and skips bounces | Needs a new platform → core input; not in M4 |
| Buildings | `massing: "varied"`, `decorations` and `replaceModel` are not drawn; the captured glow does not pulse; `soft` masses are not rounded; facade patterns are procedural (no texture atlas); roof parts above the walls are not pickable | §6.2; the extrusion answers presses |
| Buildings | A tapped building does not bounce (engine-web's `buildingsR.bounce`) | Would need per-building animation in the custom layer |
| Street scenery | `street.props` / `street.parked` / `street.traffic` (lamps, signs, parked cars, benches, bus stops, traffic), park and street trees, and `roads.crosswalks` are not drawn, so engine-web's "hide the clutter when zoomed out" has no native counterpart | Never implemented natively (M2c scope); clearly visible side by side on the `native-m4` screen |
| Colours and lighting | The same preset reads slightly darker and flatter natively: engine-web shades with a hemisphere + sun light, tone mapping and exposure, the native engine with MapLibre's extrusion lighting plus the time-of-day tint | §2.1, §6.6; the palettes themselves are the resolved theme's |
| Themes | Cinematic grading, the post pass (haze, vignette, grade), fog and the 300 ms theme cross-fade are missing; the time-of-day tint is applied instead | §6.6 |
| Drops | The orbiting note sprites, the "+value" text and the collect chime are missing | §6.3 |
| Characters | Ink outlines, the silhouette pass behind buildings and `wave` are missing | §6.4 |
| Geofences | The ring does not pulse | §2.2 |

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
    `setLabelContent`, the label styles as far as views allow, character name tags; **done**, §6.5) and
    `procedural` worlds (**done**: C++ port
    of engine-web's generators with a conformance fixture, loaded through the WorldData path, §6.8).
  - **M2c (done).** The custom building layer on the SDKs' custom layer APIs (iOS
    `MLNCustomStyleLayer` on Metal, Android `CustomLayerHost` on GL ES 3 with `android-sdk-opengl`): roofs,
    facade windows / storefronts / details, outlines and the captured flag from core meshes, depth-shared with
    the extrusions (§6.1, §6.2). Not in M2c: varied massing, decorations, replaced models, ID-buffer picking,
    cinematic grading / post pass (M4); the layer has no per-frame core data yet, so the core thread + frame
    snapshot (§3) are still not needed.
  - **Fallback.** Fork + patch queue (pin `UPSTREAM`, `maprama` layer type, CI artifacts) and an
    `mbgl`-backed `MapAdapter`, only if a later milestone cannot be built on the SDKs' custom layer APIs.
- **M3 — game systems.**
  - **M3-core (done).** Pure C++ ports of engine-web's travel planning / follower (Dijkstra over the planar
    road graph, subway legs between the stations nearest to both ends: no separate station graph), location
    smoothing, drop collection and geofence tracking, fixture-conformance tested.
  - **M3a (done).** `GameSession` (§2.2): every M3 command, event and request on `engine="native"`
    with engine-web semantics, drawn with GeoJSON style layers; device location feeds; camera follow.
  - **M3b (done).** glTF characters (cgltf, GPU skinning, 150 ms cross-fades), the procedural body,
    vehicles and 3D drop items as a model pass of the M2c custom layer, depth-shared with the extrusions
    (§6.3, §6.4); name tags are drawn by the M2b label views (§6.5).
- **M4 — parity and performance (this change).**
  - Zoom-out game view (§6.7): engine-web's factor and thresholds ported and fixture-tested, the `mapColors`
    overlay and 40 % heights, the low-detail range of the custom layer, icon discs beyond D2.
  - Performance and memory measured on both simulators against §8 (below), with the idle-animation frame gating
    that came out of it. **Real devices are still unmeasured.**
  - Parity walked row by row with both engines on the same example screen (`native-m4`, engine toggle); the
    remaining differences are listed in §11.
  - `engine="native"` beta candidate; with M2b labels merged the parity matrix has no capability gaps left.

## 12. Third-party components (NOTICE list for this package)

| Component | License | Used for | Status |
| --- | --- | --- | --- |
| MapLibre Native | BSD-2-Clause | Base renderer: official prebuilt iOS / Android SDKs linked by apps (M1); three `custom_layer*` headers vendored in `android/src/main/cpp/vendor/maplibre` (M2c) | used; root `NOTICE` entry with the license text (M2c) |
| cgltf | MIT | glTF 2.0 / GLB loading | used (M3b): `cpp/vendor/cgltf/cgltf.h` from tag v1.15, unmodified, with its `LICENSE`; root `NOTICE` entry |
| earcut.hpp | ISC | — | **not used**: roof caps use a small ear-clipping triangulator in `BuildingMesh.cpp` (MapLibre's bundled copy is not reachable through the prebuilt SDKs) |
| nlohmann/json | MIT | — | **not used** (self-written JS-semantics parser, §6.4) |

## 13. Core behaviour summary (M1 + M2a + M2b labels and procedural worlds + M2c + M3a + M3b)

| Input | Output |
| --- | --- |
| Engine `start()` | `ready {engine: {name: "maprama-native", version: "0.1.0", kind: "native"}}` |
| Envelope failing `decodeCommand` rules | `error {code: "invalid_message", message: <exact decodeCommand error>, fatal: false}` |
| `init` with `world.kind = "data"` / `"url"` | `WorldStore` loaded, map style (with the game layers) sent, game state rebuilt (§2.2), default framing then `init.camera`; load failures `error {world_load_failed, fatal: true}` (url messages as engine-web: `HTTP <status> while loading <url>`, `failed to load <url>: …`, `invalid WorldData from <url>: …`); theme, ui, labels and locationSource applied; `labelsIndex {labels}` after the load (before `init.camera`) |
| `init` with `world.kind = "procedural"` | World generated by the C++ port of engine-web's town / grid generators (same seed → same world, §6.8), converted to WorldData and loaded like `data` (extruded buildings keep the generator's palette index); default framing at the generator's start point, then `init.camera`; the game state is rebuilt on the generator's road graph, stations, start and demo loop ways (§2.2) |
| `setCamera` | Merged into the camera and applied to the map (§5.1); `follow` eases the camera towards the character every tick; unknown id → `error {unknown_character, "setCamera: cannot follow \"<id>\": no such character"}` |
| `setTheme` | Resolved theme → changed paint properties + light, and the rebuilt custom building layer (facades, details, outlines, window lights); `zoomOut` re-applied at the current camera distance; varied massing / grading warn-logged once |
| Camera distance change with `theme.zoomOut` ≠ `none` | The zoom-out factor eases to `smooth01((distance − 55 units) / 55)` in 16 ms frames (§6.7): `mapColors` fades the flat map-colour overlay in and scales the extrusions and the custom layer to `1 − 0.6 t`; from `t ≥ 0.5` the custom layer draws its low-detail range; beyond 110 units characters and drops become icon discs (`ModelLayerFrame::sprites`) |
| `setBuildingStyle` | Colour / captured override as data-driven extrusion paint; roof / facade / captured flag in the custom building layer; `error {unknown_building \| not_ready, fatal: false}` |
| `setLabels` / `setLabelContent` | Spec / host content replaced; cards re-measured (`measureLabels`) and re-placed (`setLabelFrame`); `ground` / `sign` warn-logged once |
| Camera report / viewport / theme / ui change | Labels re-placed synchronously; `setLabelFrame` only when the placement changed |
| World load, `setTheme`, `setBuildingStyle`, adapter attach | `MapAdapter::setBuildingLayer(data)` after the style, only when the layer content changed |
| Game tick with characters or drops on screen | `MapAdapter::setModelLayer(frame)`: palettes, instances and draws of every body, vehicle and drop item (one empty frame when the last disappears) |
| Game tick with `showNameTag` characters | Name tags (`nameTagAnchor`) placed with the labels in the next `setLabelFrame` (cards `tag:<id>`); hidden 95+ units from the camera, from a 0.6 zoom-out factor on, over a HUD zone; one empty update clears them |
| `setUi` | `MapUiState` (scale bar, zoom buttons + compass, attribution + logo, content inset) sent when it changes; `locationPuck` draws the puck under the player; `contentInset` applied in full (§11.1: camera anchor, `fitBounds`, ornaments, labels, markers, `camera:idle`, `ScreenPoint.visible`) |
| `upsertCharacters` / `removeCharacters` | Characters created / merged / removed (kept until a world loads); > 1 player → `error {invalid_character, "upsertCharacters: at most one character can be the player (got a, b)"}`; removal cancels trips; `model` loads the glTF (shared by URI, parsed off the lock) and shows it skinned, else the procedural body; a failed load → `error {model_load_failed, "character <id>: failed to load <uri>: <reason>", fatal: false}` |
| `setLocationSource` / `pushLocation` / device fixes | `simulated` demo loop, `external` fixes, `device` platform feed (`error {location_unavailable, "device geolocation failed: …"}`); smoothed fixes drive `follow: "location"` characters along the roads |
| `travel` / `cancelTravel` | `travel:start`, throttled `travel:progress`, `travel:arrive` / `travel:cancel`; `error {not_ready, "travel: no world loaded (send init first)"}`, `error {unknown_character, "travel: unknown character \"<id>\""}` |
| `setDropLayer` / `removeDropLayer` | `drop:collect {layerId, dropId, characterId, coordinate, collectId}` once per drop and collector; duplicate collectIds → `error {internal}`; 3D items with engine-web's animation; failed `model` drops → coin + `error {model_load_failed, "drop <layer>/<id>: failed to load <uri>: <reason>"}` |
| `setGeofences` | `geofence:enter` / `geofence:exit` in geofence order, then character order |
| `subscribe` / `unsubscribe` `character:position` / `travel:progress` | Throttled per subscription and key (engine-web `ThrottledTopic`) |
| `setOverlayAnchors` | `overlay:positions {positions: [{id, x, y, visible}]}` at most once per 16 ms frame while the view changes |
| Platform tap | `building:press {buildingId, coordinate}` or `map:press {coordinate}` |
| `subscribe` / `unsubscribe` `camera:change` | `camera:change {camera: {center, distance, pitch, bearing ∈ [0, 360)}}` once on subscribe (after a world load), then throttled on every change |
| `subscribe` / `unsubscribe` `camera:idle` | `camera:idle {camera, bounds, radiusMeters, reason}` 150 ms after the camera comes to rest (and once on subscribe), floored by `throttleMs` |
| `request` `project` / `unproject` | `response {ok: true, result: {x, y, visible} \| {coordinate \| null}}` through the adapter; `ok: false, not_ready` without a laid-out view |
| `request` `snapToRoad` / `route` | `response {ok: true, result: SnapToRoadResult \| null \| RouteResult}` (engine-web's planner, real-world ETA); `ok: false, not_ready` without a world |
| Any other command | Ignored with a `LogLevel::Warn` log (the protocol has no warning event) |
| Outgoing events (debug/tests) | Validated with `validateEngineEvent`; invalid ones dropped and logged |
