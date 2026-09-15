// Maprama native core — M2c building layer: roofs, facade detail, outlines and the captured look as
// meshes for the platform custom render layers (iOS `MLNCustomStyleLayer` on Metal, Android
// `CustomLayerHost` on GL ES 3), drawn inside MapLibre's render pass on top of the M2a `fill-extrusion`
// walls (DESIGN.md §6.1, §6.2).
//
// Geometry follows engine-web's `BuildingRenderer` (`render/buildings.ts`) for box massing:
//   - roofs: `gable` (ridge along the long side) and `dome` (drum + hemisphere) on rectangular footprints,
//     otherwise the flat roof of the facade set (gravel + parapet + HVAC for `real`, membrane + parapet +
//     deck / solar / HVAC for `modern` / `urban`, a small dome for `soft`, the light overhanging cap slab
//     for `toy` / `none`), with the same mulberry32 draws;
//   - facades: one quad per wall edge with a procedural window pattern of the facade set (the shader draws
//     engine-web's texture layout: punched windows, ribbon windows or curtain wall, lit windows at night),
//     storefront bands, and with `buildings.details` the slab edges, fins, balconies and cornice;
//   - outlines (`buildings.outline`, the toy ink): screen-space lines on corners, roof edges and eaves;
//   - `state: "captured"`: the glow mixed into every colour (as the extrusion) and the flag on the roof.
// The extrusion (M2a) keeps drawing the walls and answering rendered-feature presses.
//
// Coordinates: every vertex is placed through `Projection` and web mercator exactly (no per-world
// linearisation), relative to a mercator origin, in "local units" = mercator × `unitsPerMercator`
// (≈ meters east / south at the origin); z is meters up, like `fill-extrusion-height`. The platform
// multiplies MapLibre's projection matrix with `buildingLayerMatrix`.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "maprama/MapAdapter.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/Projection.hpp"
#include "maprama/ThemeResolver.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/WorldStyle.hpp"

namespace maprama {

/// Window pattern drawn by the fragment shader (`BuildingMeshVertex::normal[3]`).
enum class FacadePattern : std::uint8_t {
  /// Windows inside `window` (x0, x1, y0, y1) of each cell.
  Punched = 0,
  /// A glass band y0..y1 across the cell, mullions narrower than x0 at the cell edges.
  Ribbon = 1,
  /// Glass everywhere except mullions (x < x0) and spandrels (y < y0).
  Curtain = 2,
  /// Shop windows (like Punched, lit more often at night).
  Storefront = 3,
  /// Plain surface.
  None = 255,
};

/// One mesh vertex (48 bytes, identical layout in the Metal and GL vertex descriptors).
struct BuildingMeshVertex {
  /// Local units: x east, y south (mercator × `unitsPerMercator`), z meters up.
  float position[3];
  /// Unit normal (east, south, up) as snorm8; [3] = `FacadePattern`.
  std::int8_t normal[4];
  /// Surface colour (sRGB 0-255, time-of-day tinted, captured glow mixed in); a = 255.
  std::uint8_t color[4];
  /// Window pattern coordinates in world units: u along the wall, v above the ground.
  float facade[2];
  /// Extrusion shading factor: MapLibre's vertical gradient on vertical faces, 1 elsewhere.
  float shade;
  /// Window cell size in world units (column width, floor height).
  float cell[2];
  /// Window rectangle inside a cell: x0, x1, y0, y1 (/255).
  std::uint8_t window[4];
  /// Glass colour rgb (tinted) and a per-building seed for lit windows.
  std::uint8_t glass[4];
};
static_assert(sizeof(BuildingMeshVertex) == 48, "BuildingMeshVertex layout is shared with the shaders");

/// One outline vertex (32 bytes). Each segment is a quad of 4 vertices expanded in screen space.
struct BuildingLineVertex {
  float position[3];
  /// The segment's other end.
  float other[3];
  /// Expansion side (±1); the far-end vertices carry the negated side so the quad stays consistent.
  float side;
  std::uint8_t color[4];
};
static_assert(sizeof(BuildingLineVertex) == 32, "BuildingLineVertex layout is shared with the shaders");

/// MapLibre's extrusion light as the shaders use it (`Position::calculateCartesian`, anchor `map`).
struct BuildingLayerLight {
  /// Cartesian light position in (east, south, up).
  float position[3] = {0.f, 0.f, 1.f};
  float color[3] = {1.f, 1.f, 1.f};
  float intensity = 0.5f;
};

/// What was generated for one rendered building (tests, diagnostics).
struct BuildingMeshInfo {
  /// Index into `renderedBuildings(world)`.
  std::size_t rendered = 0;
  /// The roof actually drawn (`gable` / `dome` only on rectangular footprints, engine-web's rule).
  RoofShape roof = RoofShape::Flat;
  /// Wall height (world units, height scale applied) and engine-web's roof `top`: the ridge / dome apex, or
  /// the flat roof surface the flag stands on (parapets and roof furniture rise up to 0.55 units above it).
  double wallTop = 0.0;
  double roofTop = 0.0;
  bool facade = false;
  bool details = false;
  bool flag = false;
  bool rectangular = false;
  std::uint32_t firstVertex = 0;
  std::uint32_t vertexCount = 0;
  std::uint32_t firstIndex = 0;
  std::uint32_t indexCount = 0;
  std::uint32_t firstLineVertex = 0;
  std::uint32_t lineVertexCount = 0;
};

/// Everything the custom layer draws, rebuilt by the session when the world, theme or a building style
/// changes. Immutable once handed to the platform (shared between the core and the render thread).
struct BuildingLayerData {
  /// Monotonic per session; the platform re-uploads when it changes.
  std::uint64_t version = 0;
  /// Web-mercator origin (0..1) of the local units, and local units per mercator unit.
  double originX = 0.0;
  double originY = 0.0;
  double unitsPerMercator = 1.0;

  std::vector<BuildingMeshVertex> vertices;
  std::vector<std::uint32_t> indices;
  /// M4 zoom-out: `indices` without the facade details and roof furniture (same vertices), drawn instead of
  /// `indices` while `BuildingLayerZoom::lowDetail` (engine-web hides small clutter from the same zoom-out factor).
  std::vector<std::uint32_t> lowDetailIndices;
  std::vector<BuildingLineVertex> lineVertices;
  std::vector<std::uint32_t> lineIndices;

  BuildingLayerLight light;
  /// Window lights at night (`TIMES[timeOfDay].lights`, 0 = off).
  float windowLights = 0.f;
  /// Outline width in density-independent pixels (0 when the theme has no outlines).
  float lineWidth = 0.f;

  std::vector<BuildingMeshInfo> buildings;

  /// Same geometry and uniforms (the version is ignored).
  bool sameContent(const BuildingLayerData& other) const;
};

/// Builds the layer for a world, a resolved theme (and its `MapLook`) and the building overrides
/// (keyed by building id, as `MapSession` keeps them). Deterministic.
BuildingLayerData buildBuildingLayer(const WorldData& world, const Projection& projection,
                                     const std::vector<RenderedBuilding>& rendered, const ResolvedTheme& theme,
                                     const MapLook& look, const std::map<std::string, BuildingOverride>& overrides);

/// The style light (`MapLight`) as MapLibre's extrusion shader sees it.
BuildingLayerLight buildingLayerLight(const MapLight& light);

/// Web mercator (0..1, y down) of a coordinate, MapLibre's `Projection::project` / worldSize.
std::array<double, 2> lngLatToMercator(const LngLat& lngLat);
LngLat mercatorToLngLat(double x, double y);

/// Model-view-projection of the custom layer: `projection` (MapLibre's column-major
/// `nearClippedProjectionMatrix`, world pixels at `zoom` with z in meters) × local units -> world pixels.
/// Computed in double so the float result keeps centimetre precision anywhere in the world.
std::array<float, 16> buildingLayerMatrix(const std::array<double, 16>& projection, double zoom, const BuildingLayerData& data);

/// MapLibre GL backend: the 3D depth range `[0, R]` fill-extrusions use, from the depth range MapLibre set for
/// the custom layer (`depthModeForSublayer(0)` = R + (1 + layersAbove) · 3 · 2⁻¹⁶) and the number of style
/// layers drawn above it. Metal and Vulkan use the full range (no call needed).
double glExtrusionDepthRange(double customLayerDepth, int layersAbove);

}  // namespace maprama
