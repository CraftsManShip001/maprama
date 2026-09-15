# engine-native / Android wrapper (placeholder)

No build files yet. This directory will hold the thin Kotlin + JNI layer between React Native (New
Architecture only: Fabric + TurboModules/JSI, RN 0.76+) and the shared C++ core in `../cpp`. Minimum API 24.
Target ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64`. The design rationale is in [`../DESIGN.md`](../DESIGN.md),
sections 2–4 and 9.

## Classes to create

| Class / file | Kind | Responsibility |
| --- | --- | --- |
| `MapramaNativeView` (`MapramaNativeView.kt`) | Android `FrameLayout` hosting the patched MapLibre `MapView` (`TextureView` mode) | Owns the `maprama::Engine` through a JNI handle (`long nativePtr`). Forwards size changes → `setViewport`, `Choreographer.FrameCallback` → `frame`, and gesture detectors → the camera. Commands and events never go through view props or events. |
| `MapramaNativeViewManager` (`MapramaNativeViewManager.kt`) | Fabric view manager (`SimpleViewManager` implementing codegen `MapramaNativeViewManagerInterface`) | Props: `engineId` only. Registers the view in `MapramaEngineRegistry` on mount and unregisters it on drop. |
| `MapramaNativeViewNativeComponent.ts` | Codegen spec (JS) | Same spec as iOS: `codegenNativeComponent<NativeProps>('MapramaNativeView')`. |
| `MapramaEngineModule` (C++ TurboModule, shared with iOS) | TurboModule | The same JSI host functions as iOS: `postMessage`, `postMessages`, `postEnvelope`, `postBuffer` and `setEventHandler`. It is registered through the app's `cxxModuleProvider` (a pure C++ TurboModule), so Kotlin never sees protocol messages. |
| `NativeMapramaEngineModule.ts` | Codegen spec (JS) | Same spec as iOS. |
| `MapramaPackage` (`MapramaPackage.kt`) | `BaseReactPackage` | Exposes the view manager. The C++ module is exposed through `OnLoad.cpp`. |
| `MapramaMessageSinkAndroid` (`maprama_jni.cpp`) | C++ implementing `maprama::MessageSink` | Batches events per frame and delivers them on the JS thread via `CallInvoker::invokeAsync`. Sends logs to `__android_log_print` (tag `MapramaEngine`). |
| `MapramaLocationProvider` (`MapramaLocationProvider.kt`) | Kotlin | `LocationManager` (fused provider when Play Services is present) for `setLocationSource("device")`. Forwards fixes over JNI to `CharacterSystem::onDeviceLocation`. |
| `MapramaPlatformServices` (`MapramaPlatformServices.kt` + JNI) | Kotlin/JNI | CSPRNG (`SecureRandom`) for `drop:collect` nonces, asset URI resolution (`AssetManager`), and HTTP for `world.kind = "url"` (MapLibre `HttpRequest` / OkHttp). |
| `CMakeLists.txt` + `build.gradle` | Build | `externalNativeBuild` compiles `../cpp/src/*.cpp` (C++17) and links the patched MapLibre AAR's native library produced by CI from `../patches`. |

## Rules

- Keep the wrapper thin. Protocol decoding, validation and all behaviour live in C++ (`maprama::Dispatcher`).
- Never block the JS thread or the UI thread. Commands are enqueued onto the core thread.
- No legacy architecture (`ReactContextBaseJavaModule` / bridge) code paths.
