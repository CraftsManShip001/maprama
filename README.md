# Maprama

Maprama is a React Native library for 2.5D game-style maps: stylised city
dioramas built from OpenStreetMap and public building data, with characters,
travel, collectible drops, geofences and custom building styles.

- React Native first (New Architecture, RN 0.76+, Expo supported).
- Declarative components plus ref imperative methods.
- Swappable engine: v1 is a web engine (three.js) inside a WebView; a native
  engine is planned. Both speak the same message protocol
  (`@maprama/protocol`).

## Status

Early development. APIs are unstable and nothing is published to npm yet.
Every npm workspace below (`packages/*`, `tools/*`, `services/*`, `example`)
builds and typechecks from the repository root, and those with tests run them
there too. `docs` and `reference/preview` sit outside the workspaces.

## Monorepo layout

| Path                     | Package / purpose                                                                          | Status                                                    | Main commands (from the root)                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`      | `@maprama/protocol`: shared types, message codec and validation, geo projection, themes    | implemented                                               | `npm run build -w @maprama/protocol` · `npm test -w @maprama/protocol`                                          |
| `packages/engine-web`    | `@maprama/engine-web`: three.js render engine that runs inside a WebView (v1 engine)        | implemented                                               | `npm run build -w @maprama/engine-web` · `npm test -w @maprama/engine-web` · `npm run screenshot -w @maprama/engine-web` · `npm run dev -w @maprama/engine-web` |
| `packages/react-native`  | `@maprama/react-native`: `<MapramaView>`, `<Character>`, `<DropLayer>`, overlays, hooks, Expo config plugin | implemented                                   | `npm run build -w @maprama/react-native` · `npm test -w @maprama/react-native`                                  |
| `packages/engine-native` | `@maprama/engine-native`: native engine (v2) on a MapLibre Native fork                      | design and C++ core in progress; not used by the app yet | `npm test -w @maprama/engine-native` (fixtures, design coverage, C++ core tests, patch queue)                     |
| `tools/osm`              | `@maprama/osm`: OpenStreetMap + public building data to `WorldData` builder                  | implemented                                               | `npm run build -w @maprama/osm` · `npm test -w @maprama/osm` · `npm run sample:seongsu -w @maprama/osm`          |
| `tools/assets`           | `@maprama/assets`: asset pipeline (glTF optimisation, Draco / Meshopt, textures)             | implemented                                               | `npm run build -w @maprama/assets` · `npm test -w @maprama/assets`                                              |
| `services/api`           | `@maprama/api`: service API (world data hosting, drops, collection verification)             | implemented                                               | `npm test -w @maprama/api` · `npm run dev:local -w @maprama/api` · `npm run dev -w @maprama/api` (wrangler)      |
| `example`                | `@maprama/example`: Expo example app                                                         | runs on the iOS simulator                                 | `npm run ios -w @maprama/example` · `npm run typecheck -w @maprama/example` · `npm run e2e -w @maprama/example` |
| `docs`                   | `@maprama/docs`: VitePress documentation site with a live playground (not a workspace)       | implemented                                               | `npm run docs:dev` · `npm run docs:build`                                                                       |
| `reference/preview`      | Browser prototype of the whole product (read-only reference)                                | present (read-only)                                       | open `reference/preview/preview.html` in a browser                                                              |

## Development

Requires Node.js 22.12+ and npm (workspaces).

```sh
npm install
npm run build        # protocol first, then every workspace
npm run typecheck
npm test
npm run docs:build   # installs docs dependencies on first use
```

`packages/engine-native` tests need a C++ toolchain and CMake; the engine-web
and docs screenshot scripts need Google Chrome (`CHROME_PATH` to override).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
Map data (c) OpenStreetMap contributors, ODbL.
