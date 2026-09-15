// Vendored unchanged (below this comment) from MapLibre Native, tag android-v13.6.1,
// include/mln/style/layers/custom_layer_render_parameters.hpp. Copyright (c) MapLibre contributors, BSD-2-Clause (see ../../../../LICENSE.md).
// Only the CustomLayerHost interface is used: the prebuilt AAR ships no C++ headers (DESIGN.md §6.1).
#pragma once

#include <memory>
#include <array>

namespace mln {

class PaintParameters;

namespace style {

/**
 * Parameters that define the current camera position for a
 * `CustomLayerHost::render()` function.
 */
struct CustomLayerRenderParameters {
    double width;
    double height;
    double latitude;
    double longitude;
    double zoom;
    double bearing;
    double pitch;
    double fieldOfView;

    /// Standard projection matrix (nearZ = 1 tile unit).
    /// Use this for 2D/flat custom geometry.
    std::array<double, 16> projectionMatrix;

    /// A 4×4 matrix representing the map view’s current near clip projection state.
    std::array<double, 16> nearClippedProjectionMatrix;

    CustomLayerRenderParameters(const PaintParameters&);
};

} // namespace style
} // namespace mln
