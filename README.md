# Diorama

> Codename. The final project name is not decided yet.

Diorama is a React Native library for 2.5D game-style maps: stylised city
dioramas built from OpenStreetMap and public building data, with characters,
travel, collectible drops, geofences and custom building styles.

- React Native first (New Architecture, RN 0.76+, Expo supported).
- Declarative components plus ref imperative methods.
- Swappable engine: v1 is a web engine (three.js) inside a WebView; a native
  engine is planned. Both speak the same message protocol
  (`@diorama/protocol`).

## Status

Early development. APIs are unstable and nothing is published to npm yet.
Every npm workspace below (`packages/*`, `tools/*`, `services/*`, `example`)
builds and typechecks from the repository root, and those with tests run them
there too. `docs` and `reference/preview` sit outside the workspaces.

## Monorepo layout

| Path                     | Package / purpose                                                                          | Status                                                    | Main commands (from the root)                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`      | `@diorama/protocol`: shared types, message codec and validation, geo projection, themes    | implemented                                               | `npm run build -w @diorama/protocol` · `npm test -w @diorama/protocol`                                          |
| `packages/engine-web`    | `@diorama/engine-web`: three.js render engine that runs inside a WebView (v1 engine)        | implemented                                               | `npm run build -w @diorama/engine-web` · `npm test -w @diorama/engine-web` · `npm run screenshot -w @diorama/engine-web` · `npm run dev -w @diorama/engine-web` |
| `packages/react-native`  | `@diorama/react-native`: `<DioramaMap>`, `<Character>`, `<DropLayer>`, overlays, hooks, Expo config plugin | implemented                                   | `npm run build -w @diorama/react-native` · `npm test -w @diorama/react-native`                                  |
| `packages/engine-native` | `@diorama/engine-native`: native engine (v2) on a MapLibre Native fork                      | design and C++ core in progress; not used by the app yet | `npm test -w @diorama/engine-native` (fixtures, design coverage, C++ core tests, patch queue)                     |
| `tools/osm`              | `@diorama/osm`: OpenStreetMap + public building data to `WorldData` builder                  | implemented                                               | `npm run build -w @diorama/osm` · `npm test -w @diorama/osm` · `npm run sample:seongsu -w @diorama/osm`          |
| `tools/assets`           | `@diorama/assets`: asset pipeline (glTF optimisation, Draco / Meshopt, textures)             | implemented                                               | `npm run build -w @diorama/assets` · `npm test -w @diorama/assets`                                              |
| `services/api`           | `@diorama/api`: service API (world data hosting, drops, collection verification)             | implemented                                               | `npm test -w @diorama/api` · `npm run dev:local -w @diorama/api` · `npm run dev -w @diorama/api` (wrangler)      |
| `example`                | `@diorama/example`: Expo example app                                                         | runs on the iOS simulator                                 | `npm run ios -w @diorama/example` · `npm run typecheck -w @diorama/example` · `npm run e2e -w @diorama/example` |
| `docs`                   | `@diorama/docs`: VitePress documentation site with a live playground (not a workspace)       | implemented                                               | `npm run docs:dev` · `npm run docs:build`                                                                       |
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
