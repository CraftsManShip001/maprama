// M2c custom building layer on the official MapLibre iOS SDK (Metal backend): draws the core's
// `BuildingLayerData` (roofs, facade windows / details, outlines, captured flag) inside MapLibre's render
// pass, depth-tested against the `fill-extrusion` walls (DESIGN.md §6.1). Since M3b the same layer also draws
// the core's `ModelLayerFrame` (glTF / procedural characters, vehicles and drop items) with GPU skinning, in the
// same pass and depth range, right after the building meshes. Obj-C++ only (included from .mm).
#import <MapLibre/MapLibre.h>

#include <memory>

#include "maprama/BuildingMesh.hpp"
#include "maprama/ModelLayer.hpp"

NS_ASSUME_NONNULL_BEGIN

/// Style layer id of the custom building layer (inserted directly below `buildings` in every style).
extern NSString *const MapramaBuildingLayerIdentifier;

@interface MapramaBuildingLayer : MLNCustomStyleLayer

- (instancetype)initWithIdentifier:(NSString *)identifier NS_DESIGNATED_INITIALIZER;

/// Replaces the drawn data (main thread). Uploaded on the next frame; triggers a redraw.
- (void)setData:(std::shared_ptr<const maprama::BuildingLayerData>)data;

/// M3b: replaces the model frame (main thread); triggers a redraw. Mesh buffers and textures are uploaded once
/// per `ModelMesh::id` and kept while frames use them.
- (void)setModelFrame:(std::shared_ptr<const maprama::ModelLayerFrame>)frame;

@end

NS_ASSUME_NONNULL_END
