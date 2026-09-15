// Maprama native core — M3b model cache: loads glTF / GLB models by URI for characters and `model` drops.
//
//   - `data:` URIs are decoded and parsed on a worker (`AsyncRunner`, off the engine lock);
//   - other URIs (http(s), file) are fetched through `MapAdapter::fetchBinary`, then parsed on a worker; external
//     buffers / images the file references are fetched the same way (resolved against the model URI) and the
//     file is parsed again with them;
//   - results come back through the runner's delivery (engine lock held) to the `Listener`.
// Like engine-web's `gltfCache`, loaded models are shared by every user of the URI and a failed URI is not
// cached: the next request loads it again. Not thread-safe (engine lock).
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "maprama/GltfLoader.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/ModelMesh.hpp"

namespace maprama {

class ModelLibrary {
 public:
  /// Runs `job` off the engine lock; the closure it returns is then run with the engine lock held.
  using AsyncRunner = std::function<void(std::function<std::function<void()>()> job)>;

  class Listener {
   public:
    virtual ~Listener() = default;
    virtual void modelReady(const std::string& uri, const std::shared_ptr<const ModelAsset>& asset) = 0;
    virtual void modelFailed(const std::string& uri, const std::string& message) = 0;
    virtual void modelWarning(const std::string& uri, const std::string& message) = 0;
  };

  enum class State : std::uint8_t { Absent, Loading, Ready, Failed };

  explicit ModelLibrary(Listener& listener) : listener_(listener) {}

  /// Without a runner the parsing runs inline (unit tests of the library).
  void setRunner(AsyncRunner runner) { runner_ = std::move(runner); }
  void setImageDecoder(ImageDecoder decoder) { decode_ = std::move(decoder); }
  /// Fetches requested before an adapter was attached start when one attaches.
  void attachAdapter(MapAdapter* adapter);
  void detachAdapter() { adapter_ = nullptr; }

  State state(const std::string& uri) const;
  std::shared_ptr<const ModelAsset> asset(const std::string& uri) const;
  /// Starts loading `uri` unless it is loading or loaded.
  void request(const std::string& uri);
  /// Reply to `MapAdapter::fetchBinary`.
  void onBinaryFetched(std::uint64_t token, bool ok, std::string bytesOrError);

  std::size_t loadingCount() const;

 private:
  struct Entry {
    State state = State::Absent;
    std::uint64_t generation = 0;
    std::shared_ptr<const std::string> bytes;
    ModelResources resources;
    std::size_t pendingFetches = 0;
    std::shared_ptr<const ModelAsset> asset;
  };
  struct Fetch {
    std::string uri;
    /// Empty = the model file itself, else the reference as written in the file.
    std::string resource;
    std::uint64_t generation = 0;
  };

  void startFetch(const std::string& uri, const std::string& resource, const std::string& url, std::uint64_t generation);
  void parse(const std::string& uri);
  void onParsed(const std::string& uri, std::uint64_t generation, GltfLoadResult result);
  void fail(const std::string& uri, const std::string& message);

  Listener& listener_;
  AsyncRunner runner_;
  ImageDecoder decode_;
  MapAdapter* adapter_ = nullptr;
  std::map<std::string, Entry> entries_;
  std::map<std::uint64_t, Fetch> fetches_;
  std::vector<std::pair<std::uint64_t, std::string>> queued_;
  std::uint64_t nextToken_ = 1;
  std::uint64_t nextGeneration_ = 1;
};

}  // namespace maprama
