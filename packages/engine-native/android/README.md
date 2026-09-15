# engine-native / Android wrapper

The thin Kotlin + JNI layer between React Native (New Architecture only: Fabric + TurboModules, RN 0.80+)
and the shared C++ core in `../cpp`. `build.gradle` (autolinked through `../react-native.config.js`)
applies the React Native Gradle plugin for codegen, compiles the core with CMake (`CMakeLists.txt`) into
`libmaprama_engine.so`, and depends on the official prebuilt **MapLibre Native Android SDK**, OpenGL ES
variant (`org.maplibre.gl:android-sdk-opengl:13.6.1` since M2c: the default artifact renders with Vulkan and
the custom building layer is a GL ES 3 host). Minimum API 24. Design: [`../DESIGN.md`](../DESIGN.md)
§2.1 (map adapter), §3–4, §6.1 (custom layer), §9.

## Classes (M1)

| Class / file | Kind | Responsibility |
| --- | --- | --- |
| `MapramaNativeView` (`MapramaNativeView.kt`) | `FrameLayout` hosting a MapLibre `MapView` (TextureView mode) | Owns the engine through a JNI handle, created when the `engineId` prop arrives. Implements `MapramaMapHost` (the core's `MapAdapter`): style JSON, zoom/pitch preferences, `moveCamera` / `easeCamera`, `projection.toScreenLocation` / `fromScreenLocation` (dp ↔ px), `HttpURLConnection` for `world.kind = "url"`, `Handler` frames. Reports `OnCameraMove` / `OnCameraIdle` to `Engine::onCameraChanged`. Measures and lays out the `MapView` itself (Fabric does not measure native children). |
| `MapramaNativeViewManager` (`MapramaNativeViewManager.kt`) | Fabric view manager (`SimpleViewManager` + codegen `MapramaNativeViewManagerInterface`) | Prop `engineId`; destroys the view's engine and map on drop. |
| `MapramaEngineModule` (`MapramaEngineModule.kt`) | Codegen TurboModule (`NativeMapramaEngineModuleSpec`) | `postMessage` / `postMessages` → JNI → `EngineRegistry`; `dispatchEvent` (called from C++) emits `onEngineEvent` (`{engineId, envelope}`), buffering until the module's JS object exists. |
| `MapramaJni` + `MapramaMapHost` (`MapramaJni.kt`) | JNI entry points / adapter interface | The only surface between Kotlin and `libmaprama_engine.so`. |
| `maprama_jni.cpp` (`src/main/cpp`) | C++ | `JniMapAdapter` (`MapAdapter` → `MapramaMapHost`), `JniMessageSink` (events → `MapramaEngineModule.dispatchEvent`, logs → logcat tag `MapramaEngine`), engine handles, UTF-16 ↔ UTF-8 conversion. |
| `maprama_building_layer.cpp` (`src/main/cpp`, M2c) | C++ `mln::style::CustomLayerHost` (GL ES 3) | Draws the core's `BuildingLayerData` (roofs, facade windows / details, outlines, captured flag) in MapLibre's render pass with its `nearClippedProjectionMatrix` and the extrusions' depth range (read back from `GL_DEPTH_RANGE`). Registered from Kotlin as `CustomLayer("maprama-buildings-3d", MapramaJni.createBuildingLayerHost(handle))` below `buildings`; shares `BuildingLayerState` with `JniMapAdapter`; logs `maprama-frame-stats` to logcat tag `MapramaBuildingLayer`. |
| `vendor/maplibre` (`src/main/cpp`) | Vendored headers | `mln/style/layers/custom_layer_host.hpp`, `custom_layer_init_parameters.hpp`, `custom_layer_render_parameters.hpp` from MapLibre Native tag `android-v13.6.1`, unchanged (BSD-2-Clause, `LICENSE.md`); the AAR ships no C++ headers. |
| `MapramaEnginePackage` (`MapramaEnginePackage.kt`) | `BaseReactPackage` | Exposes the TurboModule and the view manager. |

Later milestones add `MapramaLocationProvider` (M3), `MapramaPlatformServices` (M3), and replace `MapView`
+ `JniMapAdapter` with the patched `mbgl::Map` (M2).

## Rules

- Keep the wrapper thin. Protocol decoding, validation and all behaviour live in C++ (`maprama::Dispatcher`,
  `maprama::MapSession`).
- Never block the JS thread or the UI thread, and never call back into the engine synchronously from a
  `MapramaMapHost` method.
- No legacy architecture (`ReactContextBaseJavaModule` / bridge) code paths.
