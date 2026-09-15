// Maprama native engine — Fabric component view (`MapramaNativeView`).
//
// Hosts an `MLNMapView` (official MapLibre iOS SDK, M1) and owns one `maprama::Engine`, registered in
// `maprama::EngineRegistry` under the `engineId` prop. The view implements the core's `MapAdapter`
// (style JSON, camera, project/unproject, URL loads, frame scheduling) and reports camera changes back.
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface MapramaNativeView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
