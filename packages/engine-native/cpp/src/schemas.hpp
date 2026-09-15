// Internal: protocol runtime checks ported 1:1 from geo.ts, world.ts,
// theme.ts, labels.ts, entities.ts and messages.ts (same field order, same
// messages). Built once, on first use (thread-safe static init).
#pragma once

#include "validate.hpp"

namespace maprama::schemas {

const validate::Check& lngLat();
const validate::Check& worldData();
const validate::Check& worldSource();
const validate::Check& themeSpec();
const validate::Check& themePreset();
const validate::Check& engineCommand();
const validate::Check& engineEvent();

}  // namespace maprama::schemas
