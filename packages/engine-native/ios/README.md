# engine-native / iOS wrapper (placeholder)

No build files yet. This directory will hold the thin Obj-C++ layer between React Native (New Architecture
only: Fabric + TurboModules/JSI, RN 0.76+) and the shared C++ core in `../cpp`. Minimum iOS 15.1. The
design rationale is in [`../DESIGN.md`](../DESIGN.md), sections 2–4 and 9.

## Classes to create

| Class / file | Kind | Responsibility |
| --- | --- | --- |
| `DioramaNativeView` (`DioramaNativeView.h/.mm`) | Fabric component view (`RCTViewComponentView` subclass) | Hosts the patched MapLibre Native map (Metal backend) plus the diorama layer. Owns the `diorama::Engine` for its lifetime. Forwards layout size → `Engine::setViewport`, `CADisplayLink` → `Engine::frame`, and gesture recognisers → the camera. Props are only `engineId` (string) and `style` (layout). Commands and events never go through Fabric props or events. |
| `DioramaNativeViewNativeComponent.ts` | Codegen spec (JS) | `codegenNativeComponent<NativeProps>('DioramaNativeView')`. Generates `DioramaNativeViewComponentDescriptor`. |
| `DioramaEngineModule` (`DioramaEngineModule.h/.mm`, backed by a C++ TurboModule shared with Android) | TurboModule | JSI host functions: `postMessage(engineId, envelope: string)`, `postMessages(engineId, string[])`, `postEnvelope(engineId, object)`, `postBuffer(engineId, ArrayBuffer)` (zero-copy bulk path) and `setEventHandler(engineId, fn)`. It looks the engine up in `DioramaEngineRegistry`. |
| `NativeDioramaEngineModule.ts` | Codegen spec (JS) | `TurboModuleRegistry.getEnforcing<Spec>('DioramaEngineModule')`. |
| `DioramaEngineRegistry` | C++ (shared) | Thread-safe `engineId → std::weak_ptr<diorama::Engine>` map. The view registers on mount and unregisters on unmount. |
| `DioramaMessageSinkApple` | Obj-C++ implementing `diorama::MessageSink` | Batches `onEvent` envelopes per frame and delivers them on the JS thread via `facebook::react::CallInvoker::invokeAsync` to the handler from `setEventHandler`. Sends `onLog` to `os_log` (subsystem `diorama.engine`). |
| `DioramaLocationProvider` | Obj-C | `CLLocationManager` wrapper for `setLocationSource("device")`. Starts and stops on the main thread and forwards fixes to `CharacterSystem::onDeviceLocation`. |
| `DioramaPlatformServices` | Obj-C++ | CSPRNG (`SecRandomCopyBytes`) for `drop:collect` nonces, bundle asset URI resolution for glTF `asset://` URIs, and the HTTP file source (`NSURLSession`) for `world.kind = "url"`. |
| `DioramaEngineNative.podspec` | CocoaPods | Compiles `../cpp/src/*.cpp` (C++17, compatible with RN's C++20) and links the prebuilt patched MapLibre XCFramework produced by CI from `../patches`. |

## Rules

- Keep the wrapper thin. Protocol decoding, validation and all behaviour live in C++ (`diorama::Dispatcher`),
  so iOS and Android cannot drift apart.
- Never block the JS thread. `postMessage` only enqueues onto the core thread.
- Do not use Paper/bridge APIs. The package declares New Architecture only.
