#import "MapramaNativeView.h"

#import <MapLibre/MapLibre.h>
#import <QuartzCore/QuartzCore.h>
#import <os/log.h>

#import <React/RCTFabricComponentsPlugins.h>
#import <react/renderer/components/MapramaEngineNativeSpec/ComponentDescriptors.h>
#import <react/renderer/components/MapramaEngineNativeSpec/Props.h>
#import <react/renderer/components/MapramaEngineNativeSpec/RCTComponentViewHelpers.h>

#import "MapramaEngineModule.h"

#include <memory>
#include <string>

#include "maprama/Engine.hpp"
#include "maprama/EngineRegistry.hpp"
#include "maprama/MapAdapter.hpp"

using namespace facebook::react;

namespace {

NSString *toNSString(std::string_view text) {
  NSString *s = [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
  return s ?: @"";
}

os_log_t engineLog() {
  static os_log_t log = os_log_create("dev.maprama.engine", "core");
  return log;
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
  AppleMapAdapter(MLNMapView *mapView, std::weak_ptr<maprama::Engine> engine) : mapView_(mapView), engine_(std::move(engine)) {}

  void setStyleJson(std::string styleJson) override {
    NSString *json = toNSString(styleJson);
    onMain(^(MLNMapView *map) {
      map.styleJSON = json;
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

  void unproject(std::uint64_t token, double x, double y) override {
    std::weak_ptr<maprama::Engine> weakEngine = engine_;
    onMain(^(MLNMapView *map) {
      const CLLocationCoordinate2D c = [map convertPoint:CGPointMake(x, y) toCoordinateFromView:map];
      std::optional<maprama::LngLat> result;
      if (CLLocationCoordinate2DIsValid(c)) result = maprama::LngLat{c.longitude, c.latitude};
      if (auto engine = weakEngine.lock()) engine->onUnprojected(token, result);
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

  __weak MLNMapView *mapView_;
  std::weak_ptr<maprama::Engine> engine_;
};

}  // namespace

@interface MapramaNativeView () <RCTMapramaNativeViewViewProtocol, MLNMapViewDelegate>
@end

@implementation MapramaNativeView {
  MLNMapView *_mapView;
  NSString *_engineId;
  std::shared_ptr<maprama::Engine> _engine;
  std::shared_ptr<AppleMapAdapter> _adapter;
  CGSize _viewportSize;
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
    self.contentView = _mapView;
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
  _adapter = std::make_shared<AppleMapAdapter>(_mapView, engine);
  engine->attachMapAdapter(_adapter);
  _viewportSize = CGSizeZero;
  [self pushViewport];
  engine->start();
}

- (void)stopEngine {
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

#pragma mark - MLNMapViewDelegate

- (void)mapViewRegionIsChanging:(MLNMapView *)mapView {
  [self reportCamera:mapView];
}

- (void)mapView:(MLNMapView *)mapView regionDidChangeAnimated:(BOOL)animated {
  [self reportCamera:mapView];
}

- (void)mapView:(MLNMapView *)mapView didFinishLoadingStyle:(MLNStyle *)style {
  [self reportCamera:mapView];
}

@end

Class<RCTComponentViewProtocol> MapramaNativeViewCls(void) {
  return MapramaNativeView.class;
}
