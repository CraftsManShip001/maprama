#import "MapramaNativeView.h"

#import <CoreLocation/CoreLocation.h>
#import <MapLibre/MapLibre.h>
#import <QuartzCore/QuartzCore.h>
#import <os/log.h>

#import <React/RCTFabricComponentsPlugins.h>
#import <react/renderer/components/MapramaEngineNativeSpec/ComponentDescriptors.h>
#import <react/renderer/components/MapramaEngineNativeSpec/Props.h>
#import <react/renderer/components/MapramaEngineNativeSpec/RCTComponentViewHelpers.h>

#import "MapramaBuildingLayer.h"
#import "MapramaEngineModule.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "maprama/Engine.hpp"
#include "maprama/EngineRegistry.hpp"
#include "maprama/MapAdapter.hpp"

using namespace facebook::react;

/// Style layer queried for `building:press` (`world_style::kLayerBuildings`).
static NSString *const kBuildingsLayer = @"buildings";

@interface MapramaNativeView () <RCTMapramaNativeViewViewProtocol, MLNMapViewDelegate, UIGestureRecognizerDelegate,
                                 CLLocationManagerDelegate>
- (void)maprama_setStyleJson:(NSString *)json;
- (void)maprama_setSourceData:(NSString *)json source:(NSString *)sourceId;
- (void)maprama_startLocation;
- (void)maprama_stopLocation;
- (void)maprama_setPaintProperties:(const std::vector<maprama::PaintPropertyChange> &)changes;
- (void)maprama_setLight:(const maprama::MapLight &)light;
- (void)maprama_setUi:(const maprama::MapUiState &)ui;
- (void)maprama_setBuildingLayer:(std::shared_ptr<const maprama::BuildingLayerData>)data;
@end

namespace {

NSString *toNSString(std::string_view text) {
  NSString *s = [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
  return s ?: @"";
}

os_log_t engineLog() {
  static os_log_t log = os_log_create("dev.maprama.engine", "core");
  return log;
}

UIColor *colorFromRgb(std::uint32_t rgb) {
  return [UIColor colorWithRed:((rgb >> 16) & 0xFF) / 255.0 green:((rgb >> 8) & 0xFF) / 255.0 blue:(rgb & 0xFF) / 255.0 alpha:1.0];
}

/// `#RRGGBB` (the core only sends that form for constant colors).
UIColor *colorFromCss(NSString *css) {
  if (css.length != 7 || ![css hasPrefix:@"#"]) return nil;
  unsigned int rgb = 0;
  if (![[NSScanner scannerWithString:[css substringFromIndex:1]] scanHexInt:&rgb]) return nil;
  return colorFromRgb(rgb);
}

/// Style-spec paint property name -> `MLNStyleLayer` KVC key (`fill-extrusion-color` -> `fillExtrusionColor`).
NSString *styleLayerKey(NSString *property) {
  static NSDictionary<NSString *, NSString *> *exceptions = @{
    @"fill-extrusion-vertical-gradient" : @"fillExtrusionHasVerticalGradient",
    @"line-dasharray" : @"lineDashPattern",
    @"circle-pitch-alignment" : @"circlePitchAlignment",
  };
  if (NSString *key = exceptions[property]) return key;
  NSArray<NSString *> *parts = [property componentsSeparatedByString:@"-"];
  NSMutableString *key = [parts.firstObject mutableCopy];
  for (NSUInteger i = 1; i < parts.count; ++i) {
    NSString *p = parts[i];
    if (p.length == 0) continue;
    [key appendString:[[p substringToIndex:1] uppercaseString]];
    [key appendString:[p substringFromIndex:1]];
  }
  return key;
}

/// A style-spec value as JSON -> NSExpression. Constant colors must be `UIColor` constants (the SDK reads
/// constant values directly); expressions go through `expressionWithMLNJSONObject:`.
NSExpression *expressionFromJson(NSString *json) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id object = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil];
  if (object == nil) return nil;
  if ([object isKindOfClass:NSString.class]) {
    UIColor *color = colorFromCss(object);
    return [NSExpression expressionForConstantValue:color ?: object];
  }
  if ([object isKindOfClass:NSNumber.class]) return [NSExpression expressionForConstantValue:object];
  return [NSExpression expressionWithMLNJSONObject:object];
}

/// Engine output -> JS (TurboModule event emitter) and os_log.
class AppleMessageSink final : public maprama::MessageSink {
 public:
  explicit AppleMessageSink(NSString *engineId) : engineId_([engineId copy]) {}

  void onEvent(std::string envelopeJson) override {
    [MapramaEngineEvents emitEnvelope:toNSString(envelopeJson) engineId:engineId_];
  }

  void onLog(maprama::LogLevel level, std::string_view message) override {
    os_log_type_t type = OS_LOG_TYPE_DEFAULT;
    switch (level) {
      case maprama::LogLevel::Debug:
        type = OS_LOG_TYPE_DEBUG;
        break;
      case maprama::LogLevel::Info:
        type = OS_LOG_TYPE_INFO;
        break;
      case maprama::LogLevel::Warn:
        type = OS_LOG_TYPE_DEFAULT;
        break;
      case maprama::LogLevel::Error:
        type = OS_LOG_TYPE_ERROR;
        break;
    }
    const std::string text(message);
    os_log_with_type(engineLog(), type, "%{public}s", text.c_str());
  }

 private:
  NSString *engineId_;
};

/// `maprama::MapAdapter` over `MLNMapView`. Every call hops to the main queue asynchronously (the core
/// holds its lock while calling in); replies go back through the engine's `on*` methods.
class AppleMapAdapter final : public maprama::MapAdapter {
 public:
  AppleMapAdapter(MapramaNativeView *view, MLNMapView *mapView, std::weak_ptr<maprama::Engine> engine)
      : view_(view), mapView_(mapView), engine_(std::move(engine)) {}

  void setStyleJson(std::string styleJson) override {
    NSString *json = toNSString(styleJson);
    onView(^(MapramaNativeView *view) {
      [view maprama_setStyleJson:json];
    });
  }

  void setPaintProperties(const std::vector<maprama::PaintPropertyChange> &changes) override {
    const std::vector<maprama::PaintPropertyChange> copy = changes;
    onView(^(MapramaNativeView *view) {
      [view maprama_setPaintProperties:copy];
    });
  }

  void setLight(const maprama::MapLight &light) override {
    const maprama::MapLight copy = light;
    onView(^(MapramaNativeView *view) {
      [view maprama_setLight:copy];
    });
  }

  void setUi(const maprama::MapUiState &ui) override {
    const maprama::MapUiState copy = ui;
    onView(^(MapramaNativeView *view) {
      [view maprama_setUi:copy];
    });
  }

  void setBuildingLayer(std::shared_ptr<const maprama::BuildingLayerData> data) override {
    onView(^(MapramaNativeView *view) {
      [view maprama_setBuildingLayer:data];
    });
  }

  void setCameraLimits(const maprama::MapCameraLimits &limits) override {
    const maprama::MapCameraLimits l = limits;
    onMain(^(MLNMapView *map) {
      map.minimumZoomLevel = l.minZoom;
      map.maximumZoomLevel = l.maxZoom;
      map.minimumPitch = l.minPitch;
      map.maximumPitch = l.maxPitch;
    });
  }

  void moveCamera(const maprama::MapCameraPose &pose, double durationMs) override {
    const maprama::MapCameraPose p = pose;
    onMain(^(MLNMapView *map) {
      const CLLocationCoordinate2D center = CLLocationCoordinate2DMake(p.center.lat, p.center.lng);
      // The map converts the camera altitude back to a zoom level with MLNZoomLevelForAltitude(…, frame size);
      // using the inverse function with the same size makes the resulting zoom exactly `p.zoom`.
      const CLLocationDistance altitude = MLNAltitudeForZoomLevel(p.zoom, p.pitch, p.center.lat, map.frame.size);
      MLNMapCamera *camera = [MLNMapCamera cameraLookingAtCenterCoordinate:center
                                                                  altitude:altitude
                                                                     pitch:p.pitch
                                                                   heading:p.bearing];
      if (durationMs > 0) {
        [map setCamera:camera
                       withDuration:durationMs / 1000.0
            animationTimingFunction:[CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut]];
      } else {
        [map setCamera:camera animated:NO];
      }
    });
  }

  void project(std::uint64_t token, const maprama::LngLat &coordinate) override {
    const maprama::LngLat c = coordinate;
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    onMain(^(MLNMapView *map) {
      const CGPoint point = [map convertCoordinate:CLLocationCoordinate2DMake(c.lat, c.lng) toPointToView:map];
      if (auto engine = weakEngine.lock()) engine->onProjected(token, point.x, point.y);
    });
  }

  void projectPoints(std::uint64_t token, const std::vector<maprama::LngLat> &coordinates) override {
    const std::vector<maprama::LngLat> copy = coordinates;
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    onMain(^(MLNMapView *map) {
      std::vector<maprama::ScreenPoint> points;
      points.reserve(copy.size());
      for (const maprama::LngLat &c : copy) {
        const CGPoint p = [map convertCoordinate:CLLocationCoordinate2DMake(c.lat, c.lng) toPointToView:map];
        points.push_back(maprama::ScreenPoint{p.x, p.y, false});
      }
      if (auto engine = weakEngine.lock()) engine->onPointsProjected(token, std::move(points));
    });
  }

  void unproject(std::uint64_t token, double x, double y) override {
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    onMain(^(MLNMapView *map) {
      const CLLocationCoordinate2D c = [map convertPoint:CGPointMake(x, y) toCoordinateFromView:map];
      std::optional<maprama::LngLat> result;
      if (CLLocationCoordinate2DIsValid(c)) result = maprama::LngLat{c.longitude, c.latitude};
      if (auto engine = weakEngine.lock()) engine->onUnprojected(token, result);
    });
  }

  void queryBuilding(std::uint64_t token, double x, double y) override {
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    onMain(^(MLNMapView *map) {
      const CGPoint point = CGPointMake(x, y);
      std::optional<std::string> buildingId;
      NSArray<id<MLNFeature>> *features = [map visibleFeaturesAtPoint:point
                                         inStyleLayersWithIdentifiers:[NSSet setWithObject:kBuildingsLayer]];
      for (id<MLNFeature> feature in features) {
        id value = feature.attributes[@"id"];
        if ([value isKindOfClass:NSString.class]) {
          buildingId = std::string([(NSString *)value UTF8String]);
          break;
        }
      }
      const CLLocationCoordinate2D c = [map convertPoint:point toCoordinateFromView:map];
      std::optional<maprama::LngLat> ground;
      if (CLLocationCoordinate2DIsValid(c)) ground = maprama::LngLat{c.longitude, c.latitude};
      if (auto engine = weakEngine.lock()) engine->onBuildingQueried(token, buildingId, ground);
    });
  }

  void fetchText(std::uint64_t token, const std::string &url) override {
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    NSString *urlString = toNSString(url);
    NSURL *nsurl = [NSURL URLWithString:urlString];
    if (nsurl == nil) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (auto engine = weakEngine.lock()) {
          engine->onTextFetched(token, false, std::string("failed to load ") + urlString.UTF8String + ": invalid URL");
        }
      });
      return;
    }
    NSURLSessionDataTask *task = [NSURLSession.sharedSession
          dataTaskWithURL:nsurl
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          auto engine = weakEngine.lock();
          if (!engine) return;
          const std::string u(urlString.UTF8String);
          if (error != nil) {
            engine->onTextFetched(token, false, "failed to load " + u + ": " + error.localizedDescription.UTF8String);
            return;
          }
          NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 200;
          if (status < 200 || status >= 300) {
            engine->onTextFetched(token, false, "HTTP " + std::to_string(status) + " while loading " + u);
            return;
          }
          engine->onTextFetched(token, true, std::string(static_cast<const char *>(data.bytes), data.length));
        }];
    [task resume];
  }

  void setSourceData(const std::string &sourceId, std::string geojson) override {
    NSString *source = toNSString(sourceId);
    NSString *json = toNSString(geojson);
    onView(^(MapramaNativeView *view) {
      [view maprama_setSourceData:json source:source];
    });
  }

  void startLocationUpdates() override {
    onView(^(MapramaNativeView *view) {
      [view maprama_startLocation];
    });
  }

  void stopLocationUpdates() override {
    onView(^(MapramaNativeView *view) {
      [view maprama_stopLocation];
    });
  }

  void scheduleFrame(double delayMs) override {
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    const int64_t delayNs = static_cast<int64_t>(std::max(0.0, delayMs) * NSEC_PER_MSEC);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayNs), dispatch_get_main_queue(), ^{
      if (auto engine = weakEngine.lock()) engine->frame(CACurrentMediaTime() * 1000.0);
    });
  }

 private:
  void onMain(void (^block)(MLNMapView *map)) {
    __weak MLNMapView *weakMap = mapView_;
    dispatch_async(dispatch_get_main_queue(), ^{
      MLNMapView *map = weakMap;
      if (map != nil) block(map);
    });
  }

  void onView(void (^block)(MapramaNativeView *view)) {
    __weak MapramaNativeView *weakView = view_;
    dispatch_async(dispatch_get_main_queue(), ^{
      MapramaNativeView *view = weakView;
      if (view != nil) block(view);
    });
  }

  __weak MapramaNativeView *view_;
  __weak MLNMapView *mapView_;
  std::weak_ptr<maprama::Engine> engine_;
};

UIButton *zoomButton(NSString *title, NSString *identifier, NSString *label) {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  [button setTitle:title forState:UIControlStateNormal];
  button.titleLabel.font = [UIFont systemFontOfSize:22 weight:UIFontWeightMedium];
  [button setTitleColor:[UIColor colorWithWhite:0.15 alpha:1] forState:UIControlStateNormal];
  button.backgroundColor = [UIColor colorWithWhite:1 alpha:0.94];
  button.layer.cornerRadius = 8;
  button.accessibilityIdentifier = identifier;
  button.accessibilityLabel = label;
  return button;
}

}  // namespace

/// Overlay above the map for the map UI: touches that hit no control fall through to the map, and its
/// subviews stay in the accessibility tree (`MLNMapView` hides its own subviews from accessibility).
@interface MapramaPassthroughView : UIView
@end

@implementation MapramaPassthroughView
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  UIView *hit = [super hitTest:point withEvent:event];
  return hit == self ? nil : hit;
}
@end

@implementation MapramaNativeView {
  UIView *_container;
  MapramaPassthroughView *_ornaments;
  MLNMapView *_mapView;
  NSString *_engineId;
  std::shared_ptr<maprama::Engine> _engine;
  std::shared_ptr<AppleMapAdapter> _adapter;
  CGSize _viewportSize;
  /// Style patches wait until the style set by `maprama_setStyleJson:` finished loading.
  BOOL _styleLoaded;
  NSMutableArray<dispatch_block_t> *_styleOps;
  // M2c custom building layer: the latest core data, drawn by a layer re-inserted into every loaded style.
  std::shared_ptr<const maprama::BuildingLayerData> _buildingData;
  MapramaBuildingLayer *_buildingLayer;
  /// Game source data (M3a) waiting for the style: only the latest data per source is kept.
  NSMutableDictionary<NSString *, NSString *> *_pendingSourceData;
  // Main-thread cost of the game source updates (logged every 5 s).
  CFTimeInterval _sourceStatsStart;
  NSUInteger _sourceUpdates;
  double _sourceTotalMs;
  double _sourceMaxMs;
  // Device location feed (`setLocationSource {kind: "device"}`); the permission is the app's job.
  CLLocationManager *_locationManager;
  BOOL _locationWanted;
  NSString *_lastLocationError;
  // Map UI drawn from `MapUiState` (the core computes every value).
  maprama::MapUiState _ui;
  UIView *_scaleBar;
  UILabel *_scaleLabel;
  UIView *_scaleLine;
  UIView *_zoomButtons;
  UILabel *_attributionLabel;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<MapramaNativeViewComponentDescriptor>();
}

// One map + engine per mounted view; never reuse a view (and its engine) for another MapramaView.
+ (BOOL)shouldBeRecycled {
  return NO;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const MapramaNativeViewProps>();
    _props = defaultProps;
    _styleOps = [NSMutableArray array];
    _pendingSourceData = [NSMutableDictionary dictionary];

    // A local, empty style: no network style is loaded before the engine sends the world style.
    _mapView = [[MLNMapView alloc] initWithFrame:self.bounds];
    _mapView.styleJSON = @"{\"version\":8,\"sources\":{},\"layers\":[{\"id\":\"background\",\"type\":\"background\",\"paint\":{\"background-color\":\"#E4DFD6\"}}]}";
    _mapView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _mapView.delegate = self;
    _mapView.minimumPitch = 0;
    _mapView.maximumPitch = 60;
    _mapView.rotateEnabled = YES;
    _mapView.pitchEnabled = YES;
    _mapView.showsUserLocation = NO;
    // Ornaments follow `MapUiState` (the core sends one on attach); hidden until then.
    _mapView.showsScale = NO;
    _mapView.logoView.hidden = YES;
    _mapView.attributionButton.hidden = YES;
    _mapView.compassView.compassVisibility = MLNOrnamentVisibilityHidden;

    // Single taps -> Engine::tap (building / map presses). They wait for the map's double-tap zoom.
    UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(handleTap:)];
    tap.delegate = self;
    tap.cancelsTouchesInView = NO;
    for (UIGestureRecognizer *recognizer in _mapView.gestureRecognizers) {
      if ([recognizer isKindOfClass:UITapGestureRecognizer.class] && ((UITapGestureRecognizer *)recognizer).numberOfTapsRequired == 2) {
        [tap requireGestureRecognizerToFail:recognizer];
      }
    }
    [_mapView addGestureRecognizer:tap];

    _container = [[UIView alloc] initWithFrame:self.bounds];
    [_container addSubview:_mapView];
    _ornaments = [[MapramaPassthroughView alloc] initWithFrame:_container.bounds];
    _ornaments.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [_container addSubview:_ornaments];
    [self createOrnaments];
    self.contentView = _container;
  }
  return self;
}

- (void)dealloc {
  [self stopEngine];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps {
  const auto &newProps = *std::static_pointer_cast<MapramaNativeViewProps const>(props);
  NSString *engineId = toNSString(newProps.engineId);
  [super updateProps:props oldProps:oldProps];
  if (engineId.length > 0 && ![engineId isEqualToString:_engineId]) [self startEngine:engineId];
}

- (void)layoutSubviews {
  [super layoutSubviews];
  [self pushViewport];
  [self layoutOrnaments];
}

#pragma mark - Engine lifecycle

- (void)startEngine:(NSString *)engineId {
  [self stopEngine];
  _engineId = [engineId copy];
  auto sink = std::make_shared<AppleMessageSink>(_engineId);
  maprama::EngineConfig config;
#if DEBUG
  config.validateOutgoingEvents = true;
#endif
  std::shared_ptr<maprama::Engine> engine = maprama::createEngine(sink, config);
  _engine = engine;
  maprama::EngineRegistry::shared().add(std::string(_engineId.UTF8String), engine);
  _adapter = std::make_shared<AppleMapAdapter>(self, _mapView, engine);
  engine->attachMapAdapter(_adapter);
  _viewportSize = CGSizeZero;
  [self pushViewport];
  engine->start();
}

- (void)stopEngine {
  [self maprama_stopLocation];
  if (!_engine) return;
  maprama::EngineRegistry::shared().remove(std::string(_engineId.UTF8String), _engine.get());
  _engine->shutdown();
  _engine.reset();
  _adapter.reset();
}

- (void)pushViewport {
  if (!_engine) return;
  const CGSize size = self.bounds.size;
  if (CGSizeEqualToSize(size, _viewportSize)) return;
  _viewportSize = size;
  const CGFloat scale = self.window.screen.scale ?: UIScreen.mainScreen.scale;
  _engine->setViewport(maprama::Viewport{size.width, size.height, scale});
}

- (void)reportCamera:(MLNMapView *)mapView {
  if (!_engine) return;
  const CLLocationCoordinate2D center = mapView.centerCoordinate;
  maprama::MapCameraPose pose;
  pose.center = maprama::LngLat{center.longitude, center.latitude};
  pose.zoom = mapView.zoomLevel;
  pose.pitch = mapView.camera.pitch;
  pose.bearing = mapView.direction;
  _engine->onCameraChanged(pose);
}

#pragma mark - Style (MapAdapter, main thread)

- (void)maprama_setStyleJson:(NSString *)json {
  // The new style carries the complete current look: patches meant for the previous one are dropped.
  _styleLoaded = NO;
  [_styleOps removeAllObjects];
  [_pendingSourceData removeAllObjects];
  _mapView.styleJSON = json;
}

- (void)maprama_setSourceData:(NSString *)json source:(NSString *)sourceId {
  if (_styleLoaded && _mapView.style != nil) {
    [self applySourceData:json source:sourceId];
  } else {
    _pendingSourceData[sourceId] = json;
  }
}

- (void)applySourceData:(NSString *)json source:(NSString *)sourceId {
  const CFTimeInterval started = CACurrentMediaTime();
  MLNSource *source = [_mapView.style sourceWithIdentifier:sourceId];
  if (![source isKindOfClass:MLNShapeSource.class]) return;
  NSError *error = nil;
  MLNShape *shape = [MLNShape shapeWithData:[json dataUsingEncoding:NSUTF8StringEncoding] encoding:NSUTF8StringEncoding error:&error];
  if (shape == nil) {
    os_log_error(engineLog(), "engine-native: invalid GeoJSON for source %{public}@: %{public}@", sourceId, error.localizedDescription);
    return;
  }
  ((MLNShapeSource *)source).shape = shape;
  [self recordSourceUpdate:(CACurrentMediaTime() - started) * 1000.0];
}

- (void)recordSourceUpdate:(double)ms {
  const CFTimeInterval now = CACurrentMediaTime();
  if (_sourceStatsStart <= 0) _sourceStatsStart = now;
  _sourceUpdates += 1;
  _sourceTotalMs += ms;
  _sourceMaxMs = std::max(_sourceMaxMs, ms);
  if (now - _sourceStatsStart < 5.0) return;
  os_log(engineLog(), "engine-native: iOS game source updates %lu in %.1f s: avg %.3f ms, max %.3f ms (main thread)",
         (unsigned long)_sourceUpdates, now - _sourceStatsStart, _sourceTotalMs / _sourceUpdates, _sourceMaxMs);
  _sourceStatsStart = now;
  _sourceUpdates = 0;
  _sourceTotalMs = 0;
  _sourceMaxMs = 0;
}

#pragma mark - Device location (MapAdapter::startLocationUpdates, main thread)

- (void)maprama_startLocation {
  if (_locationManager == nil) {
    _locationManager = [[CLLocationManager alloc] init];
    _locationManager.delegate = self;
    _locationManager.desiredAccuracy = kCLLocationAccuracyBest;
    _locationManager.distanceFilter = kCLDistanceFilterNone;
  }
  _locationWanted = YES;
  _lastLocationError = nil;
  [self applyLocationAuthorization];
}

- (void)maprama_stopLocation {
  _locationWanted = NO;
  [_locationManager stopUpdatingLocation];
}

- (void)applyLocationAuthorization {
  if (!_locationWanted || _locationManager == nil) return;
  const CLAuthorizationStatus status = _locationManager.authorizationStatus;
  if (status == kCLAuthorizationStatusAuthorizedWhenInUse || status == kCLAuthorizationStatusAuthorizedAlways) {
    _lastLocationError = nil;
    [_locationManager startUpdatingLocation];
    return;
  }
  [_locationManager stopUpdatingLocation];
  // Requesting the permission is the app's job; without it the source fails like engine-web's denied geolocation
  // (fixes start once the app obtains the permission: locationManagerDidChangeAuthorization).
  [self reportLocationError:status == kCLAuthorizationStatusNotDetermined ? @"location permission not granted"
                                                                          : @"location permission denied"];
}

- (void)reportLocationError:(NSString *)message {
  if ([message isEqualToString:_lastLocationError]) return;
  _lastLocationError = [message copy];
  if (_engine) _engine->onDeviceLocationError(std::string(message.UTF8String ?: ""));
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  [self applyLocationAuthorization];
}

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
  CLLocation *location = locations.lastObject;
  if (location == nil || !_engine || !_locationWanted) return;
  maprama::LocationFix fix;
  fix.lng = location.coordinate.longitude;
  fix.lat = location.coordinate.latitude;
  if (location.horizontalAccuracy >= 0) fix.accuracyMeters = location.horizontalAccuracy;
  if (location.course >= 0) fix.headingDeg = location.course;
  if (location.speed >= 0) fix.speedMps = location.speed;
  fix.timestamp = location.timestamp.timeIntervalSince1970 * 1000.0;
  _engine->onDeviceLocation(fix);
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
  const BOOL coreLocation = [error.domain isEqualToString:kCLErrorDomain];
  if (coreLocation && error.code == kCLErrorLocationUnknown) return;  // transient: CoreLocation keeps trying
  [self reportLocationError:coreLocation && error.code == kCLErrorDenied ? @"location permission denied" : error.localizedDescription];
}

- (void)whenStyleLoaded:(dispatch_block_t)op {
  if (_styleLoaded && _mapView.style != nil) {
    op();
  } else {
    [_styleOps addObject:[op copy]];
  }
}

- (void)maprama_setPaintProperties:(const std::vector<maprama::PaintPropertyChange> &)changes {
  const std::vector<maprama::PaintPropertyChange> copy = changes;
  __weak MapramaNativeView *weakSelf = self;
  [self whenStyleLoaded:^{
    [weakSelf applyPaintProperties:copy];
  }];
}

- (void)applyPaintProperties:(const std::vector<maprama::PaintPropertyChange> &)changes {
  MLNStyle *style = _mapView.style;
  for (const maprama::PaintPropertyChange &change : changes) {
    MLNStyleLayer *layer = [style layerWithIdentifier:toNSString(change.layerId)];
    NSExpression *value = expressionFromJson(toNSString(change.valueJson));
    if (layer == nil || value == nil) continue;
    NSString *key = styleLayerKey(toNSString(change.property));
    @try {
      [layer setValue:value forKey:key];
    } @catch (NSException *exception) {
      os_log_error(engineLog(), "engine-native: cannot set %{public}@ on layer %{public}@: %{public}@", key, layer.identifier,
                   exception.reason);
    }
  }
}

- (void)maprama_setLight:(const maprama::MapLight &)light {
  const maprama::MapLight l = light;
  __weak MapramaNativeView *weakSelf = self;
  [self whenStyleLoaded:^{
    MapramaNativeView *view = weakSelf;
    if (view == nil) return;
    MLNLight *ml = [[MLNLight alloc] init];
    ml.anchor = [NSExpression expressionForConstantValue:[NSValue valueWithMLNLightAnchor:MLNLightAnchorMap]];
    ml.position = [NSExpression
        expressionForConstantValue:[NSValue valueWithMLNSphericalPosition:MLNSphericalPositionMake(l.radial, l.azimuthal, l.polar)]];
    ml.color = [NSExpression expressionForConstantValue:colorFromRgb(l.color)];
    ml.intensity = [NSExpression expressionForConstantValue:@(l.intensity)];
    view->_mapView.style.light = ml;
  }];
}

#pragma mark - Custom building layer (M2c)

- (void)maprama_setBuildingLayer:(std::shared_ptr<const maprama::BuildingLayerData>)data {
  _buildingData = std::move(data);
  if (_buildingLayer != nil) [_buildingLayer setData:_buildingData];
  [self installBuildingLayer];
}

/// Inserts the custom layer directly below the `buildings` fill-extrusion of the loaded style (once per style):
/// both write and test depth, so the draw order only decides ties, and the same position works on every backend.
- (void)installBuildingLayer {
  MLNStyle *style = _mapView.style;
  if (!_styleLoaded || style == nil || !_buildingData) return;
  if (_buildingLayer != nil && [style layerWithIdentifier:MapramaBuildingLayerIdentifier] == _buildingLayer) return;
  MLNStyleLayer *buildings = [style layerWithIdentifier:kBuildingsLayer];
  if (buildings == nil) return;
  _buildingLayer = [[MapramaBuildingLayer alloc] initWithIdentifier:MapramaBuildingLayerIdentifier];
  [_buildingLayer setData:_buildingData];
  [style insertLayer:_buildingLayer belowLayer:buildings];
}

#pragma mark - Map UI

- (void)createOrnaments {
  _scaleBar = [[UIView alloc] init];
  _scaleBar.userInteractionEnabled = NO;
  _scaleBar.hidden = YES;
  _scaleBar.accessibilityIdentifier = @"maprama-scale-bar";
  _scaleLabel = [[UILabel alloc] init];
  _scaleLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightSemibold];
  _scaleLabel.textColor = [UIColor colorWithWhite:0.15 alpha:1];
  _scaleLine = [[UIView alloc] init];
  _scaleLine.backgroundColor = [UIColor colorWithWhite:0.15 alpha:1];
  _scaleLine.layer.borderColor = UIColor.whiteColor.CGColor;
  _scaleLine.layer.borderWidth = 0.5;
  [_scaleBar addSubview:_scaleLabel];
  [_scaleBar addSubview:_scaleLine];
  [_ornaments addSubview:_scaleBar];

  _zoomButtons = [[MapramaPassthroughView alloc] init];
  _zoomButtons.hidden = YES;
  UIButton *zoomIn = zoomButton(@"+", @"maprama-zoom-in", @"Zoom in");
  UIButton *zoomOut = zoomButton(@"−", @"maprama-zoom-out", @"Zoom out");
  [zoomIn addTarget:self action:@selector(zoomInPressed) forControlEvents:UIControlEventTouchUpInside];
  [zoomOut addTarget:self action:@selector(zoomOutPressed) forControlEvents:UIControlEventTouchUpInside];
  zoomIn.frame = CGRectMake(0, 0, 44, 44);
  zoomOut.frame = CGRectMake(0, 52, 44, 44);
  [_zoomButtons addSubview:zoomIn];
  [_zoomButtons addSubview:zoomOut];
  [_ornaments addSubview:_zoomButtons];

  _attributionLabel = [[UILabel alloc] init];
  _attributionLabel.hidden = YES;
  _attributionLabel.font = [UIFont systemFontOfSize:10];
  _attributionLabel.textColor = [UIColor colorWithWhite:0.2 alpha:1];
  _attributionLabel.backgroundColor = [UIColor colorWithWhite:1 alpha:0.75];
  _attributionLabel.textAlignment = NSTextAlignmentCenter;
  _attributionLabel.layer.cornerRadius = 4;
  _attributionLabel.clipsToBounds = YES;
  _attributionLabel.accessibilityIdentifier = @"maprama-attribution";
  [_ornaments addSubview:_attributionLabel];
}

- (void)layoutOrnaments {
  const CGSize size = _ornaments.bounds.size;
  // Scale bar: bottom-left, above the MapLibre logo when it is shown.
  const CGFloat scaleBottom = _ui.logo ? 40 : 12;
  const CGFloat width = std::max<CGFloat>(1, _ui.scaleBarWidth);
  [_scaleLabel sizeToFit];
  const CGFloat labelHeight = _scaleLabel.bounds.size.height;
  _scaleBar.frame = CGRectMake(12, size.height - scaleBottom - labelHeight - 6, std::max(width, _scaleLabel.bounds.size.width), labelHeight + 6);
  _scaleLabel.frame = CGRectMake(0, 0, _scaleLabel.bounds.size.width, labelHeight);
  _scaleLine.frame = CGRectMake(0, labelHeight + 2, width, 4);
  // Zoom buttons: right edge, vertically centred.
  _zoomButtons.frame = CGRectMake(size.width - 44 - 12, (size.height - 96) / 2, 44, 96);
  // Attribution text: bottom-right, left of MapLibre's attribution button.
  const CGFloat maxWidth = std::max<CGFloat>(40, size.width - 120);
  CGSize text = [_attributionLabel sizeThatFits:CGSizeMake(maxWidth, 20)];
  text.width = std::min(text.width + 10, maxWidth);
  _attributionLabel.frame = CGRectMake(size.width - text.width - (_ui.attribution ? 38 : 8), size.height - 8 - 18, text.width, 18);
}

- (void)maprama_setUi:(const maprama::MapUiState &)ui {
  _ui = ui;
  _mapView.logoView.hidden = !ui.logo;
  _mapView.attributionButton.hidden = !ui.attribution;
  _mapView.compassView.compassVisibility = ui.compass ? MLNOrnamentVisibilityAdaptive : MLNOrnamentVisibilityHidden;
  _scaleBar.hidden = !ui.scaleBar;
  _scaleLabel.text = toNSString(ui.scaleBarLabel);
  _zoomButtons.hidden = !ui.zoomButtons;
  _attributionLabel.hidden = !ui.attribution;
  _attributionLabel.text = toNSString(ui.attributionText);
  [self layoutOrnaments];
}

- (void)zoomInPressed {
  if (_engine) _engine->zoomButton(true);
}

- (void)zoomOutPressed {
  if (_engine) _engine->zoomButton(false);
}

#pragma mark - Presses

- (void)handleTap:(UITapGestureRecognizer *)recognizer {
  if (recognizer.state != UIGestureRecognizerStateRecognized || !_engine) return;
  const CGPoint point = [recognizer locationInView:_mapView];
  _engine->tap(point.x, point.y);
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch {
  // Presses on the map UI (zoom buttons, compass, attribution) are not map presses.
  UIView *view = touch.view;
  return !([view isKindOfClass:UIControl.class] || [view isDescendantOfView:_zoomButtons]);
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer {
  return YES;
}

#pragma mark - MLNMapViewDelegate

- (void)mapView:(MLNMapView *)mapView regionWillChangeWithReason:(MLNCameraChangeReason)reason animated:(BOOL)animated {
  // A user pan stops `setCamera.follow` (engine-web cancels following on pans, not on zoom / rotate).
  if ((reason & MLNCameraChangeReasonGesturePan) != 0 && _engine) _engine->onUserPan();
}

- (void)mapViewRegionIsChanging:(MLNMapView *)mapView {
  [self reportCamera:mapView];
}

- (void)mapView:(MLNMapView *)mapView regionDidChangeAnimated:(BOOL)animated {
  [self reportCamera:mapView];
}

- (void)mapView:(MLNMapView *)mapView didFinishLoadingStyle:(MLNStyle *)style {
  _styleLoaded = YES;
  NSArray<dispatch_block_t> *ops = [_styleOps copy];
  [_styleOps removeAllObjects];
  for (dispatch_block_t op in ops) op();
  // Every loaded style gets the M2c custom layer (below `buildings`) and the latest M3a game source data.
  [self installBuildingLayer];
  NSDictionary<NSString *, NSString *> *sources = [_pendingSourceData copy];
  [_pendingSourceData removeAllObjects];
  [sources enumerateKeysAndObjectsUsingBlock:^(NSString *sourceId, NSString *json, BOOL *stop) {
    [self applySourceData:json source:sourceId];
  }];
  [self reportCamera:mapView];
}

@end

Class<RCTComponentViewProtocol> MapramaNativeViewCls(void) {
  return MapramaNativeView.class;
}
