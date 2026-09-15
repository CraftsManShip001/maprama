# Maprama

Maprama is a React Native library for 2.5D game-style maps: stylised city
dioramas built from OpenStreetMap and public building data, with characters,
multi-mode travel, collectible drops, holographic labels, geofences and
per-building styles.

- **React Native first**: New Architecture (Fabric), RN 0.76+, Expo supported
  through a config plugin.
- **Declarative**: describe the map with components, drive it with a `ref`,
  and opt in to continuous values (character position, camera) with hooks.
- **Swappable engine**: every engine speaks the same message protocol
  (`@maprama/protocol`), so app code does not change when the engine does.

## Install

```sh
npm i @maprama/react-native react-native-webview
cd ios && pod install
```

With Expo (development build or prebuild):

```sh
npx expo install @maprama/react-native react-native-webview
npx expo install expo-location   # optional, for device location
```

Then add the plugin to `app.json`:
`"plugins": [["@maprama/react-native", { "features": ["characters", "drops", "labels", "travel"] }]]`.
See the [`@maprama/react-native` README](./packages/react-native/README.md) for
permissions and plugin options.

## Quick start

```tsx
import { useRef } from 'react';
import { MapramaView, Character, DropLayer, type MapramaViewRef } from '@maprama/react-native';

const coins = [{ id: 'c1', coord: { lng: 127.0565, lat: 37.5445 } }];

export function GameMap() {
  const map = useRef<MapramaViewRef>(null);

  return (
    <MapramaView
      ref={map}
      world={{ kind: 'procedural', layout: 'town' }}
      theme={{ base: 'urban', timeOfDay: 'golden' }}
      camera={{ pitch: 45, distance: 60, follow: 'me' }}
      location={{ source: 'simulated' }}
      onPress={(e) => map.current?.travel('me', e.coordinate, ['walk'])}
      onError={(e) => console.warn(e.code, e.message)}
      style={{ flex: 1 }}
    >
      <Character id="me" isPlayer name="Me" />
      <DropLayer
        id="coins"
        data={coins}
        getId={(c) => c.id}
        getCoordinate={(c) => c.coord}
        getType={() => 'coin'}
        onCollect={(e) => console.log('collected', e.dropId)}
      />
    </MapramaView>
  );
}
```

Use `world={{ kind: 'data', world }}` with a `WorldData` JSON built by
[`@maprama/osm`](./tools/osm) to render a real neighbourhood, or
`{ kind: 'url', url }` to load one from a server.

## Features

- Worlds from OpenStreetMap (plus optional Korean national building heights)
  or procedural towns and grids.
- Theme presets (`realistic`, `urban`, `modern`, `toy`, `minimal`, `soft`),
  time of day, cinematic grading, building massing, facades and roofs.
- Characters with glTF models and animation mapping, a player puck, name tags
  and `CharacterLayer` for many remote players.
- Travel by `walk`, `bike`, `car`, `plane` and `subway` (also mixed), with
  route snapping, progress events and a configurable time scale.
- Collectible drops (`DropLayer`) judged on the device, with optional
  server-side verification through the hosted service.
- Labels (including the holographic style) with custom content, geofences,
  per-building styles and React Native views pinned to map coordinates
  (`MapOverlay`).
- Device, simulated or externally pushed location.

## Engines

| Engine | Package | Status |
| --- | --- | --- |
| v1 web engine (three.js in a WebView) | `@maprama/engine-web` | Default. Implements the whole protocol. |
| v2 native engine (MapLibre Native, Fabric/JSI) | `@maprama/engine-native` | **In development, not part of 0.1.0.** M1 (flat map, camera, gestures) builds on the official MapLibre SDKs; buildings, labels, characters, travel and drops follow in M2–M3. |

## Documentation and example

- Documentation: <https://craftsmanship001.github.io/maprama/> (Korean): guides,
  API reference and an interactive playground running the real engine. Sources
  live in [`docs/`](./docs); `npm run docs:dev` serves them locally.
- Example app: [`example/`](./example), an Expo Router catalog with one
  screen per feature.
- Changes: [CHANGELOG.md](./CHANGELOG.md).

## Monorepo layout

| Path                     | Package / purpose                                                                          | Status                                                    | Main commands (from the root)                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`      | `@maprama/protocol`: shared types, message codec and validation, geo projection, themes    | published                                                 | `npm run build -w @maprama/protocol` · `npm test -w @maprama/protocol`                                          |
| `packages/engine-web`    | `@maprama/engine-web`: three.js render engine that runs inside a WebView (v1 engine)        | published                                                 | `npm run build -w @maprama/engine-web` · `npm test -w @maprama/engine-web` · `npm run screenshot -w @maprama/engine-web` · `npm run dev -w @maprama/engine-web` |
| `packages/react-native`  | `@maprama/react-native`: `<MapramaView>`, `<Character>`, `<DropLayer>`, overlays, hooks, Expo config plugin | published                                     | `npm run build -w @maprama/react-native` · `npm test -w @maprama/react-native`                                  |
| `packages/engine-native` | `@maprama/engine-native`: native engine (v2) on a MapLibre Native fork                      | beta (M1: flat map + camera), private                     | `npm test -w @maprama/engine-native` (fixtures, design coverage, C++ core tests, patch queue)                     |
| `tools/osm`              | `@maprama/osm`: OpenStreetMap + public building data to `WorldData` builder (CLI `maprama-osm`) | published                                            | `npm run build -w @maprama/osm` · `npm test -w @maprama/osm` · `npm run sample:seongsu -w @maprama/osm`          |
| `tools/assets`           | `@maprama/assets`: glTF/GLB inspection and optimisation (CLI `maprama`)                      | published                                                 | `npm run build -w @maprama/assets` · `npm test -w @maprama/assets`                                              |
| `services/api`           | `@maprama/api`: service API (world data hosting, drops, collection verification)             | private                                                   | `npm test -w @maprama/api` · `npm run dev:local -w @maprama/api` · `npm run dev -w @maprama/api` (wrangler)      |
| `example`                | `@maprama/example`: Expo example app                                                         | private                                                   | `npm run ios -w @maprama/example` · `npm run typecheck -w @maprama/example` · `npm run e2e -w @maprama/example` |
| `docs`                   | `@maprama/docs`: VitePress documentation site with a live playground (not a workspace)       | private                                                   | `npm run docs:dev` · `npm run docs:build`                                                                       |
| `reference/preview`      | Browser prototype of the whole product (read-only reference)                                | read-only                                                 | open `reference/preview/preview.html` in a browser                                                              |

"Published" means the package is prepared for npm (`0.1.0`); nothing has been
published yet.

## Development

Requires Node.js 22.12+ and npm (workspaces).

```sh
npm install
npm run build        # protocol first, then every workspace
npm run typecheck
npm test
npm run docs:build   # installs docs dependencies on first use
```

`packages/engine-native` tests need a C++17 compiler (`clang++` or `c++`); the
engine-web and docs screenshot scripts need Google Chrome (`CHROME_PATH` to
override). See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[SECURITY.md](./SECURITY.md).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Map data © OpenStreetMap contributors, available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
(<https://www.openstreetmap.org/copyright>). Apps that show a world built from
OpenStreetMap must display this attribution (the engine draws it when
`ui.attribution` is on). The sample world `tools/osm/samples/seongsu.world.json`
is a derived database of OpenStreetMap data and is licensed under ODbL 1.0, not
Apache-2.0.
