// Maprama native core — M3b glTF 2.0 / GLB loading with cgltf (vendored, MIT, cpp/vendor/cgltf, tag v1.15).
//
// `loadGltf` turns a file into a `ModelAsset` (engine vertex format, palette joints, TRS clips, rest bounds;
// ModelMesh.hpp). It is pure and thread-safe: the game session runs it on a worker thread, off the engine
// lock (DESIGN.md §3, §6.4). Buffers and images that the file references by relative / http(s) URI are
// reported in `missing`; the caller fetches them through the platform and calls again with `resources`.
// `data:` URIs and the GLB binary chunk are resolved here. Base colour textures (PNG / JPEG) are decoded by
// the platform decoder (ImageIO / BitmapFactory) when one is given, else skipped (base colour factor only).
//
// Not supported (the load fails with a message, the caller reports `model_load_failed` and shows the
// procedural body, like a failed load on engine-web): Draco (KHR_draco_mesh_compression) and meshopt
// (EXT_meshopt_compression / KHR_meshopt_compression) geometry, models with more than `kMaxJoints` palette
// entries, models without triangles. Morph targets, cameras, lights and non-base-colour material maps are
// ignored.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/ModelMesh.hpp"

namespace maprama {

/// Platform image decoder: PNG / JPEG bytes → RGBA8 (straight alpha). Called on worker threads.
using ImageDecoder = std::function<bool(const std::uint8_t* data, std::size_t size, ModelTexture& out)>;

/// External resources by the URI written in the file (bytes).
using ModelResources = std::map<std::string, std::shared_ptr<const std::string>>;

struct GltfLoadResult {
  std::shared_ptr<const ModelAsset> asset;
  /// External URIs (as written in the file) still needed; call again with them in `resources`.
  std::vector<std::string> missing;
  /// Failure (empty on success or when resources are missing).
  std::string error;
  /// Non-fatal notes (textures not decoded, ignored extensions).
  std::vector<std::string> warnings;
};

/// Parses a glTF (JSON) or GLB file. `uri` names the asset (diagnostics).
GltfLoadResult loadGltf(std::string_view bytes, const ModelResources& resources, const ImageDecoder& decodeImage,
                        const std::string& uri);

bool isDataUri(std::string_view uri);
/// Payload of a `data:` URI (base64 or percent-encoded); nullopt when malformed.
std::optional<std::string> decodeDataUri(std::string_view uri);
/// `relative` resolved against `base` (absolute URIs and `data:` URIs are returned unchanged).
std::string resolveUri(const std::string& base, const std::string& relative);

}  // namespace maprama
