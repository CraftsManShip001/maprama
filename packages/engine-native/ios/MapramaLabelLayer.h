// Native label views for the core's label placement (DESIGN.md §6.5, M2b).
//
// The core (LabelSystem) selects, projects and declutters the labels; this layer only draws the placed
// cards it receives (`maprama::LabelFrame`), recycling views, and measures cards for the core. Styles follow
// engine-web's stylesheet (`packages/engine-web/src/labels/dom-styles.ts`): `holo` (ground dot + leader line
// + glass card with an icon tile), `app`, `minimal`, `clean`, `sticker`. Icons are engine-web's line icons,
// replayed from the vector table generated into the core (`maprama/LabelIcons.hpp`).
#import <UIKit/UIKit.h>

#ifdef __cplusplus
#include <vector>

#include "maprama/MapAdapter.hpp"
#endif

NS_ASSUME_NONNULL_BEGIN

/// Sits above the map (below the map UI), ignores touches (they reach the map) and exposes each visible
/// card as an accessibility element ("name, type"). Main thread only.
@interface MapramaLabelLayer : UIView

/// VoiceOver activated a marker card: the host reports it as a press at that screen point (dp), which the
/// core turns into `marker:press`. Marker cards are the only pressable cards; label cards are static text.
@property(nonatomic, copy, nullable) void (^onMarkerActivate)(double x, double y);

#ifdef __cplusplus
/// Shows exactly the frame's cards (views recycled by label id); hides every other label view.
- (void)applyFrame:(const maprama::LabelFrame &)frame;
/// Card sizes (points) for the core's `measureLabels`, in order.
+ (std::vector<maprama::LabelSize>)measure:(const std::vector<maprama::LabelCardContent> &)items;
#endif

@end

NS_ASSUME_NONNULL_END
