# @maprama/engine-web

The Maprama v1 render engine: a three.js 2.5D diorama map that implements the
[`@maprama/protocol`](https://www.npmjs.com/package/@maprama/protocol) message
contract. [`@maprama/react-native`](https://www.npmjs.com/package/@maprama/react-native)
runs it inside a WebView, so React Native apps do not need to install or call
it themselves.

```sh
npm i @maprama/engine-web
```

## Usage in a browser

```ts
import { createEngine, createDirectTransport } from '@maprama/engine-web';

const transport = createDirectTransport();
transport.onEvent((event) => console.log(event));
const engine = createEngine(document.getElementById('map')!, { transport });
transport.postCommand({
  type: 'init',
  world: { kind: 'procedural', layout: 'town' },
  theme: { base: 'urban' },
  labels: {},
  ui: {},
  locationSource: 'simulated',
});
```

## Entry points

| Import | Contents |
| --- | --- |
| `@maprama/engine-web` | ESM library (`three` and `@maprama/protocol` are dependencies, not bundled). |
| `@maprama/engine-web/engine-html` | `ENGINE_HTML`: a single-file HTML document with the engine and a WebView transport inlined, for WebView hosts. |
| `@maprama/engine-web/engine.html` | The same document as a file. |
| `@maprama/engine-web/iife` | Self-contained IIFE bundle exposing the global `MapramaEngine`. |

Draco-compressed models load their decoder from gstatic.com at runtime; it is
not bundled.

## Links

- [Repository and documentation](https://github.com/CraftsManShip001/maprama)
- [Changelog](https://github.com/CraftsManShip001/maprama/blob/main/CHANGELOG.md)

## License

Apache-2.0. See `LICENSE` and `NOTICE`. The bundled three.js code is MIT
licensed (see `NOTICE`). Map data © OpenStreetMap contributors, ODbL: apps that
show OpenStreetMap-derived worlds must display this attribution (the engine
draws it when `ui.attribution` is on).
