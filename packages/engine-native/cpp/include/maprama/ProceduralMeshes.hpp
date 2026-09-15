// Maprama native core — M3b procedural meshes: engine-web's default character body (`characters.ts`
// `geos()` / `buildProcedural` and the procedural branch of `Character.animate`), the travel vehicles
// (`vehicles.ts`: bike, car, plane, subway ghost train with pop-in, wheels, crank, propeller) and the drop
// items (`drops.ts`: coin / gem, CD and LP discs, extruded music note, rarity beam and glow ring), built as
// rigid-skinned `ModelMesh`es (one palette entry per animated group) in three.js' geometry conventions.
//
// Differences to engine-web (DESIGN.md §6.3, §6.4): no ink outline hulls or silhouettes, the disc labels are
// vertex-coloured rings instead of the canvas textures (same radii and colours), the note is extruded without
// its bevel, the glow ring is a vertex-alpha disc instead of the glow texture and the orbiting note sprites are
// not drawn; materials are reduced to their base colour, lit like the buildings.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

#include "maprama/ModelMesh.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// engine-web `offsetHslHex` (three r128 `offsetHSL` on an sRGB hex colour).
std::uint32_t offsetHslHex(std::uint32_t hex, double dh, double ds, double dl);
/// engine-web `mixHex`.
std::uint32_t mixHex(std::uint32_t a, std::uint32_t b, double t);
/// engine-web `easeOutBack` (vehicle pop-in, drop appear).
double easeOutBack(double x);

// ---- Procedural character -------------------------------------------------------------------------

/// Palette entries of the procedural body: the rig group and its hip / knee / shoulder / elbow groups.
namespace procedural_rig {
inline constexpr std::uint8_t kRoot = 0, kHipL = 1, kKneeL = 2, kHipR = 3, kKneeR = 4, kShoulderL = 5, kElbowL = 6, kShoulderR = 7,
                              kElbowR = 8;
inline constexpr std::uint32_t kJoints = 9;
}  // namespace procedural_rig

/// engine-web's procedural body for a shirt colour (the player gets a cap and a backpack, NPCs hair), in world
/// units (1.9 tall, feet at 0, facing +Z). Cached per (colour, player).
std::shared_ptr<const ModelMesh> proceduralCharacterMesh(std::uint32_t color, bool isPlayer);

/// Joint angles and phase of the procedural body (engine-web `Character.phase` and the rig groups).
struct ProceduralRigState {
  double phase = 0;
  std::array<double, 2> hip{0, 0}, knee{0, 0}, shoulder{0, 0}, elbow{0, 0};
  double rigX = 0, rigY = 0, rigZ = 0, rigRotX = 0, rigRotY = 0, rigScaleY = 1;
  /// Bike crank angle (the pedalling phase).
  double crank = 0;
};

/// engine-web `Character.animate`, procedural branch. `mode` is the visible vehicle mode, `onBike` true while the
/// bike has popped in (> 0.4).
void animateProceduralRig(ProceduralRigState& state, double dt, double t, TravelMode mode, double speed, double scale, bool onBike);

/// Palette (`procedural_rig::kJoints` matrices, character-root space) of a rig state.
std::vector<Mat4> proceduralRigPalette(const ProceduralRigState& state);

// ---- Vehicles ---------------------------------------------------------------------------------------

/// The vehicle mesh of a mode (bike, car, plane, subway; nullptr for walk). Palettes: see `vehiclePalette`.
std::shared_ptr<const ModelMesh> vehicleMesh(TravelMode mode);

/// engine-web `Vehicle` (pop-in progress, direction, wheel angle).
struct VehicleState {
  double p = 0;
  int dir = 0;
  bool visible = false;
  double wheel = 0;
};

/// engine-web `VehicleSet` + the per-set animation values.
struct VehicleSetState {
  bool built = false;
  /// Bike, car, plane, subway.
  std::array<VehicleState, 4> vehicles{};
  double prop = 0;
  double carBob = 0;
  double planePitch = 0;
};

/// Index of a vehicle mode in `VehicleSetState::vehicles` (-1 for walk).
int vehicleIndex(TravelMode mode);
/// engine-web `switchVehicle`.
void switchVehicle(VehicleSetState& set, TravelMode mode);
/// engine-web `stepVehicles` (reduced motion off).
void stepVehicles(VehicleSetState& set, TravelMode mode, double speed, double dt, double t, double planePitch);
/// Group scale of a vehicle (`max(0.001, easeOutBack(p) · base)`).
double vehicleScale(const VehicleSetState& set, TravelMode mode);
/// Palette of a vehicle mesh (character-root space); `crank` is the rider's pedalling phase.
std::vector<Mat4> vehiclePalette(const VehicleSetState& set, TravelMode mode, double crank);

// ---- Drops ------------------------------------------------------------------------------------------

/// The item mesh of a drop: coin (gem when `gem`: value ≥ 50), CD / LP disc and note in the rarity colour.
/// Local frame of engine-web's `spin` group (centred at the item, which floats ≈ 0.9 units above the ground).
std::shared_ptr<const ModelMesh> dropMesh(DropType type, Rarity rarity, bool gem);
/// The rarity beam (open cone 5 units tall, additive, alpha fading upwards) and the glow ring (additive disc,
/// 2.2 units) in white: the instance colour carries the rarity colour and opacity.
std::shared_ptr<const ModelMesh> dropBeamMesh();
std::shared_ptr<const ModelMesh> dropRingMesh();
/// M4 zoom-out icon disc (radius 1 in x / z, y up, unlit): a white fill with a dark rim, coloured by the instance.
std::shared_ptr<const ModelMesh> iconDiscMesh();

/// Geometry helpers (exposed for tests): vertex / triangle counts of the built meshes are deterministic.
struct MeshStats {
  std::size_t vertices = 0;
  std::size_t triangles = 0;
};
MeshStats meshStats(const ModelMesh& mesh);

}  // namespace maprama
