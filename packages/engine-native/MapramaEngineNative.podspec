require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# @maprama/engine-native (M1): the shared C++ core (cpp/src) + the Obj-C++ Fabric view / TurboModule (ios/)
# on top of the official prebuilt MapLibre Native iOS SDK (DESIGN.md §1, §9). New Architecture only.
Pod::Spec.new do |s|
  s.name         = "MapramaEngineNative"
  s.version      = package["version"]
  s.summary      = "Maprama native engine (v2): C++ core + MapLibre Native behind a Fabric view."
  s.license      = package["license"]
  s.homepage     = "https://github.com/maprama/maprama"
  s.authors      = { "Maprama" => "maprama@users.noreply.github.com" }
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/maprama/maprama.git", :tag => "v#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm}", "cpp/src/**/*.{cpp,hpp}", "cpp/include/**/*.hpp"
  s.private_header_files = "ios/**/*.h", "cpp/src/**/*.hpp", "cpp/include/**/*.hpp"
  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp/include\" \"$(PODS_TARGET_SRCROOT)/cpp/src\"",
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
  }

  # Official prebuilt SDK (MLNMapView). The patched-fork XCFramework replaces it at M2 (DESIGN.md §10).
  # ios-v6.31.0 is published on GitHub/SPM only; the newest release on CocoaPods trunk is 6.30.0.
  s.dependency "MapLibre", "~> 6.30"
  # Device location source (M3a): CLLocationManager. glTF textures (M3b): ImageIO.
  s.frameworks = "CoreLocation", "ImageIO"

  install_modules_dependencies(s)
end
