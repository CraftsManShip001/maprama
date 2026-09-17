// MTIL v1 tile payload reader (design/tile-format.md).
//
// The C++ core does not render tile worlds yet (`WorldSource { kind: "tiles" }`
// is answered with `unsupported` by MapSession), but it must be able to *read*
// the bytes: the format is part of the protocol, and a decoder that is written
// and tested now is a decoder that cannot silently drift from the TypeScript
// one in `@maprama/protocol` (`src/tile.ts`). `cpp/tests/tile_tests.cpp` runs
// both against the same golden fixture.
//
// Pure: no network, no gzip, no PMTiles. Give it the bytes of one
// already-decompressed tile.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace maprama::tile {

/// Current MTIL payload version.
inline constexpr std::uint8_t kVersion = 1;
/// `format` string every Maprama tile archive's metadata carries.
inline constexpr const char* kFormat = "maprama-mtil-1";
/// Tile-local units per tile edge used by the built archives.
inline constexpr int kExtent = 8192;
/// Units of geometry kept outside the tile edge for clipped layers.
inline constexpr int kBuffer = 256;

/// Layer ids, fixed by the format.
enum class LayerId : std::uint8_t {
  Roads = 1,
  Buildings = 2,
  Water = 3,
  Parks = 4,
  Pois = 5,
  Stations = 6,
  Districts = 7,
};

/// A tile-local integer vertex: `u` east, `v` south (Web Mercator, y grows south).
struct Vertex {
  std::int32_t u = 0;
  std::int32_t v = 0;
};

struct Road {
  std::string id;
  std::string cls;  ///< "arterial" | "local" | "alley"
  std::optional<std::string> name;
  bool bridge = false;
  std::vector<Vertex> pts;
};

struct Building {
  std::string id;
  std::int64_t heightDm = 0;  ///< decimetres, not world units
  std::optional<std::int64_t> levels;
  std::optional<std::string> kind;  ///< "glass" | "office" | "apartment" | "brick"
  std::optional<std::string> name;
  std::vector<Vertex> footprint;
};

struct Polygon {
  std::optional<std::string> name;  ///< parks only
  std::vector<Vertex> ring;
};

struct Poi {
  std::string id;
  std::string name;
  std::string cat;
  Vertex at;
  std::optional<std::string> buildingId;  ///< may name a building in another tile
  bool snapped = false;
  double snapDistanceMeters = 0.0;
};

struct Station {
  std::string id;
  std::string name;
  Vertex at;
};

struct District {
  std::string name;
  bool water = false;
  Vertex at;
};

/// One decoded tile.
struct Tile {
  std::uint8_t version = 0;
  bool clipped = false;
  int extent = 0;
  int buffer = 0;
  /// Indices into the archive metadata `attribution` string table.
  std::vector<std::uint64_t> attribution;
  std::vector<Road> roads;
  std::vector<Building> buildings;
  std::vector<Polygon> water;
  std::vector<Polygon> parks;
  std::vector<Poi> pois;
  std::vector<Station> stations;
  std::vector<District> districts;
  /// Layer ids present in the payload that this build does not know.
  std::vector<std::uint8_t> unknownLayers;
};

struct DecodeResult {
  bool ok = false;
  Tile tile;
  std::string error;  ///< set when `ok` is false
};

/// Decodes one uncompressed MTIL v1 tile. Never throws; a malformed payload
/// comes back as `ok = false` with a message.
DecodeResult decodeTile(const std::uint8_t* bytes, std::size_t size);

inline DecodeResult decodeTile(const std::vector<std::uint8_t>& bytes) {
  return decodeTile(bytes.data(), bytes.size());
}

}  // namespace maprama::tile
