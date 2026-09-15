#include "maprama/ModelLibrary.hpp"

#include <algorithm>
#include <optional>

namespace maprama {

void ModelLibrary::attachAdapter(MapAdapter* adapter) {
  adapter_ = adapter;
  if (adapter_ == nullptr) return;
  std::vector<std::pair<std::uint64_t, std::string>> queued = std::move(queued_);
  queued_.clear();
  for (const auto& [token, url] : queued) adapter_->fetchBinary(token, url);
}

ModelLibrary::State ModelLibrary::state(const std::string& uri) const {
  const auto it = entries_.find(uri);
  return it != entries_.end() ? it->second.state : State::Absent;
}

std::shared_ptr<const ModelAsset> ModelLibrary::asset(const std::string& uri) const {
  const auto it = entries_.find(uri);
  return it != entries_.end() && it->second.state == State::Ready ? it->second.asset : nullptr;
}

std::size_t ModelLibrary::loadingCount() const {
  return static_cast<std::size_t>(
      std::count_if(entries_.begin(), entries_.end(), [](const auto& e) { return e.second.state == State::Loading; }));
}

void ModelLibrary::request(const std::string& uri) {
  const auto it = entries_.find(uri);
  if (it != entries_.end() && (it->second.state == State::Loading || it->second.state == State::Ready)) return;
  Entry& e = entries_[uri];
  e = Entry{};
  e.state = State::Loading;
  e.generation = nextGeneration_++;
  if (isDataUri(uri)) {
    parse(uri);  // decoded on the worker
  } else {
    startFetch(uri, std::string(), uri, e.generation);
  }
}

void ModelLibrary::startFetch(const std::string& uri, const std::string& resource, const std::string& url, std::uint64_t generation) {
  const std::uint64_t token = nextToken_++;
  fetches_[token] = Fetch{uri, resource, generation};
  if (adapter_ != nullptr) {
    adapter_->fetchBinary(token, url);
  } else {
    queued_.emplace_back(token, url);
  }
}

void ModelLibrary::onBinaryFetched(std::uint64_t token, bool ok, std::string bytesOrError) {
  const auto it = fetches_.find(token);
  if (it == fetches_.end()) return;
  const Fetch f = it->second;
  fetches_.erase(it);
  const auto e = entries_.find(f.uri);
  if (e == entries_.end() || e->second.generation != f.generation || e->second.state != State::Loading) return;
  if (!ok) {
    fail(f.uri, bytesOrError);
    return;
  }
  auto data = std::make_shared<const std::string>(std::move(bytesOrError));
  if (f.resource.empty()) {
    e->second.bytes = std::move(data);
    parse(f.uri);
    return;
  }
  e->second.resources[f.resource] = std::move(data);
  if (e->second.pendingFetches > 0 && --e->second.pendingFetches == 0) parse(f.uri);
}

void ModelLibrary::parse(const std::string& uri) {
  const Entry& e = entries_[uri];
  const std::uint64_t generation = e.generation;
  std::shared_ptr<const std::string> bytes = e.bytes;
  ModelResources resources = e.resources;
  ImageDecoder decode = decode_;
  // The worker part only touches its own copies; the returned closure runs with the engine lock held.
  auto job = [this, uri, generation, bytes, resources, decode]() -> std::function<void()> {
    GltfLoadResult result;
    std::optional<std::string> decoded;
    std::string_view view;
    if (bytes) {
      view = *bytes;
    } else {
      decoded = decodeDataUri(uri);
      if (decoded) {
        view = *decoded;
      } else {
        result.error = "invalid data: URI";
      }
    }
    if (result.error.empty()) result = loadGltf(view, resources, decode, uri);
    return [this, uri, generation, result = std::move(result)]() mutable { onParsed(uri, generation, std::move(result)); };
  };
  if (runner_) {
    runner_(std::move(job));
  } else {
    job()();
  }
}

void ModelLibrary::onParsed(const std::string& uri, std::uint64_t generation, GltfLoadResult result) {
  const auto it = entries_.find(uri);
  if (it == entries_.end() || it->second.generation != generation || it->second.state != State::Loading) return;
  Entry& e = it->second;
  if (!result.missing.empty()) {
    if (isDataUri(uri)) {
      fail(uri, "the model references external files (" + result.missing.front() + "), which a data: URI model cannot resolve");
      return;
    }
    const bool again = std::all_of(result.missing.begin(), result.missing.end(), [&](const std::string& m) { return e.resources.count(m) != 0; });
    if (again) {
      fail(uri, "cannot resolve " + result.missing.front());
      return;
    }
    e.pendingFetches = result.missing.size();
    for (const std::string& m : result.missing) startFetch(uri, m, resolveUri(uri, m), generation);
    return;
  }
  if (!result.error.empty()) {
    fail(uri, result.error);
    return;
  }
  e.state = State::Ready;
  e.asset = result.asset;
  e.bytes.reset();
  e.resources.clear();
  for (const std::string& w : result.warnings) listener_.modelWarning(uri, w);
  listener_.modelReady(uri, e.asset);
}

void ModelLibrary::fail(const std::string& uri, const std::string& message) {
  Entry& e = entries_[uri];
  e.state = State::Failed;
  e.bytes.reset();
  e.resources.clear();
  e.asset.reset();
  listener_.modelFailed(uri, message);
}

}  // namespace maprama
