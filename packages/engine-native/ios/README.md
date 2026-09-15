# engine-native / iOS wrapper

The thin Obj-C++ layer between React Native (New Architecture only: Fabric + TurboModules, RN 0.80+) and
the shared C++ core in `../cpp`. Built by `../MapramaEngineNative.podspec` (autolinked from the package
root), which compiles `../cpp/src/*.cpp` and `ios/*.mm` and depends on the official prebuilt
**MapLibre iOS SDK** (`MapLibre` pod, `~> 6.30`) for M1. Minimum iOS: React Native's
`min_ios_version_supported`. Design: [`../DESIGN.md`](../DESIGN.md) §2.1 (map adapter), §3–4, §9.

## Classes (M1)

| Class / file | Kind | Responsibility |
| --- | --- | --- |
| `MapramaNativeView` (`MapramaNativeView.h/.mm`) | Fabric component view (`RCTViewComponentView`, not recycled) | Hosts an `MLNMapView` and owns one `maprama::Engine`, created when the `engineId` prop arrives and registered in `maprama::EngineRegistry`. Forwards its size to `Engine::setViewport` and every camera change (`mapViewRegionIsChanging:`, `regionDidChangeAnimated:`) to `Engine::onCameraChanged`. |
| `AppleMapAdapter` (in `MapramaNativeView.mm`) | C++ `maprama::MapAdapter` | `styleJSON`, zoom/pitch limits, `setCamera:` (altitude from `MLNAltitudeForZoomLevel`), `convertCoordinate:` / `convertPoint:` for project/unproject, `NSURLSession` for `world.kind = "url"`, `dispatch_after` frames. Always hops to the main queue asynchronously and replies through the engine's `on*` methods. |
| `AppleMessageSink` (in `MapramaNativeView.mm`) | C++ `maprama::MessageSink` | Sends every event envelope to `MapramaEngineEvents` and logs to `os_log` (subsystem `dev.maprama.engine`). |
| `MapramaEngineModule` (`MapramaEngineModule.h/.mm`) | Codegen TurboModule (`NativeMapramaEngineModuleSpecBase`) | `postMessage(engineId, envelope)` / `postMessages(engineId, envelopes)` look the engine up in `EngineRegistry`; events leave through the codegen EventEmitter `onEngineEvent` (`{engineId, envelope}`). `MapramaEngineEvents` buffers events emitted before the module's JS object exists. |
| `MapramaNativeViewNativeComponent.ts`, `NativeMapramaEngineModule.ts` | Codegen specs (`../src/specs`) | `codegenConfig` `MapramaEngineNativeSpec`; `ios.componentProvider` / `ios.modulesProvider` register both classes. |

Later milestones add `MapramaLocationProvider` (`CLLocationManager`, M3), `MapramaPlatformServices`
(CSPRNG, asset URIs, M3), and replace `MLNMapView` + `AppleMapAdapter` with the patched `mbgl::Map` (M2).

## Rules

- Keep the wrapper thin. Protocol decoding, validation and all behaviour live in C++ (`maprama::Dispatcher`,
  `maprama::MapSession`), so iOS and Android cannot drift apart.
- Never block the JS thread, and never call back into the engine synchronously from a `MapAdapter` method.
- Do not use Paper/bridge APIs. The package declares New Architecture only.
