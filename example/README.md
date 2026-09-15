# Maprama Catalog (`example/`)

An Expo Router app that demonstrates every `@maprama/react-native` feature, one screen each:

| # | Screen (`app/`) | What it shows |
| --- | --- | --- |
| 1 | `themes.tsx` | Preset (`realistic`…`soft`, plus a full preset object from `@maprama/protocol/themes/urban.json`), time of day, cinematic grading, massing, facade details, `zoomOut` with a near/far camera. |
| 2 | `world.tsx` | `world.kind`: `data` (the bundled OSM Seongsu sample), `url` (local API), `procedural` `town` / `grid`. The map remounts on change because `world` is read at init. |
| 3 | `character.tsx` | Player `Character` with a bundled CC0 glTF (a `data:` URI) or the engine's default avatar. `location.source`: `simulated` / `device` / `external`, with North/South/East/West buttons pushing external fixes. Live `useCharacterPosition`. |
| 4 | `travel.tsx` | Tap the map (or a preset) to travel with `walk` / `bike` / `car` / mixed (`walk → car → walk`) / `plane` / `subway`. ETA comes from a `travel:progress` subscription; the status changes on `travel:arrive`. |
| 5 | `drops.tsx` | `DropLayer`s: coins, music (CD / vinyl / note) and a `model` drop, with rarities. Collection is judged on the device and shows a toast; "Walk onto nearest drop" pushes external fixes. Optional `source="service"` layer against the local API, which is skipped when the API is unreachable. |
| 6 | `labels.tsx` | Label style (incl. `holo`), holo icon tiles, and content modes including a custom content function refreshed with `refreshLabelContent()`. |
| 7 | `buildings.tsx` | `Geofence` "plaza" enter/exit log. Press a building (or "Pick sample building") to edit color, roof, massing, facade and `state: 'captured'` through `setBuildingStyle`. |
| 8 | `multiplayer.tsx` | `CharacterLayer` of six simulated remote players. A fake server ticks every 1 s and the client interpolates at 10 Hz. `MapOverlay` shows a card anchored to the station POI and a speech bubble following a player. |
| 9 | `native.tsx` | `engine="native"` M1 + M2a: 3D MapLibre buildings in theme colours, themes and time of day, a captured building, map / building presses, a `MapOverlay` card, map UI, camera presets and a project/unproject round trip. |
| 10 | `native-game.tsx` | `engine="native"` M3a game systems as style layers: a walker on the `simulated` location source, `travel` to near / far presets at ×20 with a route line and live ETA, two drops placed halfway along the `route` request's paths and collected on the way, a geofence with enter / exit events, the location puck and camera follow. |

Map data on the real-data screens is the Seongsu-dong sample from
`tools/osm/samples/seongsu.world.json`: © OpenStreetMap contributors, ODbL. The
engine draws the attribution because `ui.attribution` is on.

## Run on the iOS simulator

Requirements: Node 22.12+ (tested with Node 24 and Node 26 / npm 11), Xcode with an iOS simulator, CocoaPods.
Keep the checkout on a path without spaces: expo-constants' iOS build phase splits
unquoted paths, so a Release build under e.g. `~/Side Projects/` fails in `EXConstants`.

```sh
# from the repo root
npm install
npm run build -w @maprama/protocol
npm run build -w @maprama/engine-web
npm run build -w @maprama/react-native

cd example
npx expo run:ios            # prebuild + pod install + build + launch, starts Metro (debug)
```

To build without Metro (release configuration, JS bundle embedded):

```sh
cd example
npx expo prebuild --platform ios --no-install
(cd ios && pod install)
xcodebuild -workspace ios/MapramaCatalog.xcworkspace -scheme MapramaCatalog -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build build
xcrun simctl install booted ios/build/Build/Products/Release-iphonesimulator/MapramaCatalog.app
xcrun simctl launch booted dev.maprama.catalog
```

Other checks:

```sh
npx tsc --noEmit -p example                  # from the repo root
(cd example && npx expo export --platform ios)
```

`ios/` and `android/` are generated (Continuous Native Generation) and git-ignored.

## Monorepo notes

- `example` is an npm workspace (root `package.json` → `workspaces`). Expo detects the workspace root and has Metro watch it, so `@maprama/react-native`, `@maprama/protocol` and `@maprama/engine-web` resolve to the local packages' build output (`lib/`, `dist/`). Rebuild them after changing library code.
- The repo develops against Expo SDK 57's pairing: `react` / `react-dom` 19.2.3 and `react-native` 0.86.3 (from `expo/bundledNativeModules.json`). `packages/react-native` uses the same versions in its devDependencies, so the root `node_modules` holds a single copy of each and Metro needs no custom resolution. Check with `npm ls react react-native`. The library's `peerDependencies` still allow `react-native >=0.76.0` and `react >=18.3.0`.
- `react-native-screens` uses SDK 57's `~4.26.0`. `react-native-webview` stays at 14.0.1, matching `packages/react-native`. `npx expo install --check` flags that and `typescript` (SDK 57 expects 13.16.1 and ~6.0.3). The library's peer range allows either webview version.
- `metro.config.js` is Expo's default config. react-native 0.86.3 ships `rn-get-polyfills`, which Expo's Metro config loads.
- The config plugin `@maprama/react-native` in `app.json` writes `NSLocationWhenInUseUsageDescription` and `MapramaFeatures` into `Info.plist`.

## Sample character model

`src/data/sampleModel.ts` is generated by `node scripts/make-sample-model.mjs`: a
tiny glTF 2.0 robot authored from scratch (CC0) with `idle` and `walk` clips:
orange torso, mint cube head, dark visor and yellow antenna, so it is easy to
tell apart from the engine's default avatar (rounded body, skin-coloured head).
The model is
embedded as a `data:model/gltf+json;base64,...` URI. The WebView host runs with
`allowFileAccess={false}` and only whitelists inline documents, so a `require('./hero.glb')`
file asset is not guaranteed to load in release builds. A `data:` URI is
deterministic and needs no server. Models served over `https` (or from Metro in
debug) also work as plain URI strings.

## Service drops and `world.kind: 'url'` (optional)

Both need the local API, `services/api`:

```sh
# terminal 1, repo root
npm run build -w @maprama/protocol
npm run dev:local -w @maprama/api -- --port 8787 --world seongsu=../../tools/osm/samples/seongsu.world.json
# prints "client key (dev only): mpr_..." and "admin key (dev only): mpr_..."
```

```sh
# terminal 2: pass the printed client key (never commit it; example/.env.local is git-ignored)
cd example
EXPO_PUBLIC_MAPRAMA_API_KEY=mpr_... npx expo run:ios
```

| Variable | Default | Used by |
| --- | --- | --- |
| `EXPO_PUBLIC_MAPRAMA_API_URL` | `http://localhost:8787` | service drops, world URL |
| `EXPO_PUBLIC_MAPRAMA_API_KEY` | empty (service features are skipped) | service drops, world URL |
| `EXPO_PUBLIC_MAPRAMA_WORLD_URL` | `<API_URL>/v1/worlds/seongsu.json?key=<KEY>` | world screen, `url` source |
| `EXPO_PUBLIC_MAPRAMA_DROPS_CHANNEL` | `coins` | service drops |

- The dev server keeps everything in memory and has no campaigns until you create one with the admin key (`POST /v1/drops/campaigns`, see `services/api/openapi.yaml`). Until then `GET /v1/drops/nearby` returns no drops.
- The drops screen probes `GET /v1/usage` first. It mounts the service layer only when the API answers, and otherwise logs "unreachable, skipped". Fetch failures are reported through `onError` (`drops_fetch_failed`) and retried by the library after 2 s, 5 s, then every 15 s.
- `localhost` works from the iOS simulator. On a device, use your machine's LAN address (and https, or an ATS exception).

## E2E tests (Maestro)

Flows live in `.maestro/`. Every flow launches the app, opens a screen and waits
until the badge `testID="engine-status"` reads `engine ready`.

| Flow | Checks |
| --- | --- |
| `01-screens-render.yaml` | All 8 screens reach `engine ready` without a red box or fatal engine error; the sample glTF loads (no `model_load_failed`) and is screenshotted next to the engine's default avatar; geofence enter, building pick and dome roof; multiplayer ticks. Screenshots of each screen. |
| `02-travel-arrive.yaml` | Walk to the far preset (≈350 m of road): ETA from `travel:progress`, then `status: arrived`. Then the near preset (≈75 m of road) arrives with a two-digit route length. Walk is used because car arrives in a few seconds. |
| `03-drops-collect.yaml` | Starts at `collected: 0`. External fixes onto the nearest drop → at least 1 collected; a second walk gives at least 2 (the player can pass over other drops on the way). Then the `onCollect` line (`Collected … from …`) is checked in the event log. The 4 s toast is not asserted: a Maestro tap on this screen takes about 10 s to return. |
| `04-labels-holo.yaml` | Switches labels to `holo`, then to the custom content function and refreshes it. |
| `05-native-m1.yaml` | `engine="native"`: camera presets update the `camera:change` readout; a project/unproject round trip answers. The world source switches to the procedural town and back to the Seongsu data (a third map view in one screen visit), which must frame Seongsu again. |
| `06-native-m2a.yaml` | `engine="native"` M2a: 3D buildings with the station `MapOverlay` card and the visible OSM attribution; `overlay:positions` readout; the sample building styled `captured` + `#FF8800` and pressed on the map (`building:press`); toy / dusk theme; back to the station (the card follows the camera). The control panel is scrolled by swiping on it, since a swipe at the screen centre pans the map. |
| `07-native-m2c.yaml` | `engine="native"` M2c custom building layer: the picked sample building gets a gable then a dome roof (close-up from above, captured flag on the roof), its facade is switched off and on, an 8 s orbit feeds the layer's frame statistics, then the urban preset (facade details) and toy / night (ink outlines, lit windows). Screenshots of each step. |
| `08-native-m3a.yaml` | `engine="native"` M3a: the walker's `character:position` readout, the `route` readout, then travel to the near preset (drop collected, geofence entered) and to the far preset (second drop, geofence left), checked in the readouts and the event log lines of the same handlers; screenshots at start, near, while travelling, far, an overview and the log. |
| `09-native-labels.yaml` | `engine="native"` labels (M2b): the station's subway POI as a holo card (accessibility label "name, type") and the Seongsu `labelsIndex` count; a label content function (`content: custom` → `setLabelContent`) replaces its text; the app style, then labels off; the procedural town's own labels (`labelsIndex` of the generated world, holo cards); the M3a screen's character name tags ("Traveller", "Walker"). Screenshots of each step. |

```sh
cd example
maestro test .maestro        # app must be installed on a booted simulator
```

The Maestro CLI needs a Java runtime. Without one, run the same folder through the
Maestro MCP server (`run` with `dir: example/.maestro`). `takeScreenshot` paths are
relative to the Maestro process's working directory.

Tested on an iOS 26.5 simulator (iPhone 17 Pro) with the Release build above (Xcode 26.6, Node 26.5,
Maestro CLI 2.10). All four flows pass.

## Android

Not built or tested yet: this machine has no usable Java / Android SDK. Nothing
in the app is iOS-only. `app.json` sets `android.package`, and the config plugin
adds `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`. `npx expo run:android`
should work on a machine with the Android toolchain, but that is unverified.
