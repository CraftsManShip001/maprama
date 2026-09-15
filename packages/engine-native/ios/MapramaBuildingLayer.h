// M2c custom building layer on the official MapLibre iOS SDK (Metal backend): draws the core's
// `BuildingLayerData` (roofs, facade windows / details, outlines, captured flag) inside MapLibre's render
// pass, depth-tested against the `fill-extrusion` walls (DESIGN.md §6.1). Obj-C++ only (included from .mm).
#import <MapLibre/MapLibre.h>

#include <memory>

#include "maprama/BuildingMesh.hpp"

NS_ASSUME_NONNULL_BEGIN

/// Style layer id of the custom building layer (inserted directly below `buildings` in every style).
extern NSString *const MapramaBuildingLayerIdentifier;

@interface MapramaBuildingLayer : MLNCustomStyleLayer

- (instancetype)initWithIdentifier:(NSString *)identifier NS_DESIGNATED_INITIALIZER;

/// Replaces the drawn data (main thread). Uploaded on the next frame; triggers a redraw.
- (void)setData:(std::shared_ptr<const maprama::BuildingLayerData>)data;

@end

NS_ASSUME_NONNULL_END
