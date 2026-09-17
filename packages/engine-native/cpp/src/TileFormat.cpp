#include "maprama/TileFormat.hpp"

#include <array>
#include <stdexcept>

namespace maprama::tile {
namespace {

const std::array<const char*, 3> kRoadClasses{"arterial", "local", "alley"};
const std::array<const char*, 4> kBuildingKinds{"glass", "office", "apartment", "brick"};
const std::array<const char*, 8> kPoiCategories{"subway", "cafe", "store", "music", "school", "book", "plaza", "park"};

/// Thrown internally and caught in `decodeTile`, so callers never see an exception.
struct Malformed : std::runtime_error {
  explicit Malformed(const std::string& what) : std::runtime_error(what) {}
};

class Reader {
 public:
  Reader(const std::uint8_t* data, std::size_t begin, std::size_t end) : data_(data), pos_(begin), end_(end) {}

  std::size_t pos() const { return pos_; }

  std::uint8_t u8() {
    need(1);
    return data_[pos_++];
  }

  int u16() {
    need(2);
    const int v = data_[pos_] | (data_[pos_ + 1] << 8);
    pos_ += 2;
    return v;
  }

  /// Unsigned LEB128, at most 10 bytes, capped at 2^53 - 1 so the value is
  /// exactly representable the same way the JavaScript reader represents it.
  std::uint64_t varint() {
    std::uint64_t result = 0;
    std::uint64_t shift = 1;
    std::uint8_t byte = 0;
    int bytes = 0;
    do {
      need(1);
      byte = data_[pos_++];
      result += static_cast<std::uint64_t>(byte & 0x7f) * shift;
      shift *= 128;
      if (++bytes > 10) throw Malformed("varint is longer than 10 bytes");
    } while ((byte & 0x80) != 0);
    if (result > (1ULL << 53) - 1) throw Malformed("varint is out of range");
    return result;
  }

  std::int64_t svarint() {
    const std::uint64_t v = varint();
    return (v & 1) != 0 ? -static_cast<std::int64_t>((v + 1) / 2) : static_cast<std::int64_t>(v / 2);
  }

  std::string string() {
    const std::uint64_t n = varint();
    need(n);
    std::string s(reinterpret_cast<const char*>(data_ + pos_), static_cast<std::size_t>(n));
    pos_ += static_cast<std::size_t>(n);
    return s;
  }

  /// A reader over the next `n` bytes; advances this reader past them.
  Reader sub(std::uint64_t n) {
    need(n);
    Reader r(data_, pos_, pos_ + static_cast<std::size_t>(n));
    pos_ += static_cast<std::size_t>(n);
    return r;
  }

 private:
  void need(std::uint64_t n) const {
    if (pos_ + n > end_ || pos_ + n < pos_) throw Malformed("truncated tile");
  }

  const std::uint8_t* data_;
  std::size_t pos_;
  std::size_t end_;
};

struct Cursor {
  std::int64_t u = 0;
  std::int64_t v = 0;
};

std::vector<Vertex> readGeom(Reader& r, Cursor& c) {
  const std::uint64_t n = r.varint();
  std::vector<Vertex> pts;
  pts.reserve(static_cast<std::size_t>(n < 65536 ? n : 65536));
  for (std::uint64_t i = 0; i < n; ++i) {
    c.u += r.svarint();
    c.v += r.svarint();
    pts.push_back(Vertex{static_cast<std::int32_t>(c.u), static_cast<std::int32_t>(c.v)});
  }
  return pts;
}

Vertex readPoint(Reader& r, Cursor& c) {
  const std::vector<Vertex> pts = readGeom(r, c);
  if (pts.empty()) throw Malformed("point feature has no vertex");
  return pts.front();
}

void decodeRoads(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    Road f;
    f.id = r.string();
    const std::uint8_t flags = r.u8();
    const std::size_t clsIndex = flags & 0x03;
    if (clsIndex >= kRoadClasses.size()) throw Malformed("unknown road class");
    f.cls = kRoadClasses[clsIndex];
    if ((flags & 0x04) != 0) f.name = r.string();
    if ((flags & 0x08) != 0) f.bridge = true;
    f.pts = readGeom(r, c);
    tile.roads.push_back(std::move(f));
  }
}

void decodeBuildings(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    Building f;
    f.id = r.string();
    const std::uint8_t flags = r.u8();
    f.heightDm = static_cast<std::int64_t>(r.varint());
    if ((flags & 0x02) != 0) f.levels = static_cast<std::int64_t>(r.varint());
    if ((flags & 0x04) != 0) {
      const std::size_t k = r.u8();
      if (k >= kBuildingKinds.size()) throw Malformed("unknown building kind");
      f.kind = kBuildingKinds[k];
    }
    if ((flags & 0x01) != 0) f.name = r.string();
    f.footprint = readGeom(r, c);
    tile.buildings.push_back(std::move(f));
  }
}

void decodeWater(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    Polygon f;
    f.ring = readGeom(r, c);
    tile.water.push_back(std::move(f));
  }
}

void decodeParks(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    Polygon f;
    if (r.u8() != 0) f.name = r.string();
    f.ring = readGeom(r, c);
    tile.parks.push_back(std::move(f));
  }
}

void decodePois(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    Poi f;
    f.id = r.string();
    f.name = r.string();
    const std::uint8_t flags = r.u8();
    const std::size_t cat = flags & 0x0f;
    if (cat >= kPoiCategories.size()) throw Malformed("unknown POI category");
    f.cat = kPoiCategories[cat];
    if ((flags & 0x10) != 0) f.buildingId = r.string();
    if ((flags & 0x20) != 0) {
      f.snapped = true;
      f.snapDistanceMeters = static_cast<double>(r.varint()) / 10.0;
    }
    f.at = readPoint(r, c);
    tile.pois.push_back(std::move(f));
  }
}

void decodeStations(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    Station f;
    f.id = r.string();
    f.name = r.string();
    f.at = readPoint(r, c);
    tile.stations.push_back(std::move(f));
  }
}

void decodeDistricts(Reader& r, Tile& tile) {
  const std::uint64_t n = r.varint();
  Cursor c;
  for (std::uint64_t i = 0; i < n; ++i) {
    District f;
    f.name = r.string();
    if (r.u8() != 0) f.water = true;
    f.at = readPoint(r, c);
    tile.districts.push_back(std::move(f));
  }
}

bool decodeLayer(std::uint8_t id, Reader& body, Tile& tile) {
  switch (static_cast<LayerId>(id)) {
    case LayerId::Roads: decodeRoads(body, tile); return true;
    case LayerId::Buildings: decodeBuildings(body, tile); return true;
    case LayerId::Water: decodeWater(body, tile); return true;
    case LayerId::Parks: decodeParks(body, tile); return true;
    case LayerId::Pois: decodePois(body, tile); return true;
    case LayerId::Stations: decodeStations(body, tile); return true;
    case LayerId::Districts: decodeDistricts(body, tile); return true;
  }
  return false;
}

}  // namespace

DecodeResult decodeTile(const std::uint8_t* bytes, std::size_t size) {
  DecodeResult out;
  if (bytes == nullptr || size < 10) {
    out.error = "tile is too short to be MTIL";
    return out;
  }
  if (bytes[0] != 'M' || bytes[1] != 'T' || bytes[2] != 'I' || bytes[3] != 'L') {
    out.error = "not an MTIL tile (bad magic)";
    return out;
  }
  try {
    Reader r(bytes, 4, size);
    Tile tile;
    tile.version = r.u8();
    if (tile.version != kVersion) {
      out.error = "unsupported MTIL version " + std::to_string(static_cast<int>(tile.version));
      return out;
    }
    const std::uint8_t flags = r.u8();
    tile.clipped = (flags & 1) == 1;
    tile.extent = r.u16();
    if (tile.extent <= 0) {
      out.error = "invalid extent " + std::to_string(tile.extent);
      return out;
    }
    tile.buffer = r.u16();
    const std::uint64_t attrCount = r.varint();
    for (std::uint64_t i = 0; i < attrCount; ++i) tile.attribution.push_back(r.varint());
    const std::uint64_t layerCount = r.varint();
    for (std::uint64_t i = 0; i < layerCount; ++i) {
      const std::uint8_t id = r.u8();
      const std::uint64_t len = r.varint();
      Reader body = r.sub(len);
      // Forward compatibility: `byteLength` already moved the cursor past a
      // layer this build does not know.
      if (!decodeLayer(id, body, tile)) tile.unknownLayers.push_back(id);
    }
    out.ok = true;
    out.tile = std::move(tile);
    return out;
  } catch (const Malformed& e) {
    out.ok = false;
    out.error = e.what();
    return out;
  }
}

}  // namespace maprama::tile
