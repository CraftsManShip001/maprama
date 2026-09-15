// Vendored unchanged (below this comment) from MapLibre Native, tag android-v13.6.1,
// include/mln/style/layers/custom_layer_init_parameters.hpp. Copyright (c) MapLibre contributors, BSD-2-Clause (see ../../../../LICENSE.md).
// Only the CustomLayerHost interface is used: the prebuilt AAR ships no C++ headers (DESIGN.md §6.1).
#pragma once

namespace mln {
namespace style {

/**
 * Base parameters passed to CustomLayerHost::initialize().
 * Backend-specific subclasses provide device handles needed for
 * resource creation (pipelines, buffers, etc.).
 */
struct CustomLayerInitParameters {
    virtual ~CustomLayerInitParameters() = default;
};

} // namespace style
} // namespace mln
