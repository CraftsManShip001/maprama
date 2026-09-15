#import "MapramaEngineModule.h"

#import <MapramaEngineNativeSpec/MapramaEngineNativeSpec.h>

#include <string>
#include <vector>

#include "maprama/Engine.hpp"
#include "maprama/EngineRegistry.hpp"

@interface MapramaEngineModule : NativeMapramaEngineModuleSpecBase <NativeMapramaEngineModuleSpec>
- (void)deliverEnvelope:(NSString *)envelope engineId:(NSString *)engineId;
@end

namespace {

/// Envelopes emitted while no module can deliver them (bounded; oldest dropped).
constexpr NSUInteger kMaxPendingEvents = 512;

}  // namespace

static NSObject *gLock;
static __weak MapramaEngineModule *gModule;
static NSMutableArray<NSDictionary *> *gPending;

@implementation MapramaEngineEvents

+ (void)initialize {
  if (self == [MapramaEngineEvents class]) {
    gLock = [NSObject new];
    gPending = [NSMutableArray new];
  }
}

+ (void)emitEnvelope:(NSString *)envelope engineId:(NSString *)engineId {
  MapramaEngineModule *module = nil;
  @synchronized(gLock) {
    module = gModule;
    if (module == nil) {
      if (gPending.count >= kMaxPendingEvents) [gPending removeObjectAtIndex:0];
      [gPending addObject:@{@"engineId" : engineId, @"envelope" : envelope}];
      return;
    }
  }
  [module deliverEnvelope:envelope engineId:engineId];
}

+ (void)attachModule:(MapramaEngineModule *)module {
  NSArray<NSDictionary *> *pending;
  @synchronized(gLock) {
    gModule = module;
    pending = [gPending copy];
    [gPending removeAllObjects];
  }
  for (NSDictionary *event in pending) [module deliverEnvelope:event[@"envelope"] engineId:event[@"engineId"]];
}

@end

@implementation MapramaEngineModule

RCT_EXPORT_MODULE(MapramaEngineModule)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper {
  [super setEventEmitterCallback:eventEmitterCallbackWrapper];
  // The emitter can only be used once the JS object of this module exists (it installs the callback).
  [MapramaEngineEvents attachModule:self];
}

- (void)deliverEnvelope:(NSString *)envelope engineId:(NSString *)engineId {
  [self emitOnEngineEvent:@{@"engineId" : engineId, @"envelope" : envelope}];
}

- (void)postMessage:(NSString *)engineId envelope:(NSString *)envelope {
  std::shared_ptr<maprama::Engine> engine = maprama::EngineRegistry::shared().find(std::string(engineId.UTF8String));
  if (!engine) {
    NSLog(@"[maprama] postMessage: no native engine registered for %@ (view not mounted yet?)", engineId);
    return;
  }
  engine->postMessage(std::string_view(envelope.UTF8String));
}

- (void)postMessages:(NSString *)engineId envelopes:(NSArray *)envelopes {
  std::shared_ptr<maprama::Engine> engine = maprama::EngineRegistry::shared().find(std::string(engineId.UTF8String));
  if (!engine) {
    NSLog(@"[maprama] postMessages: no native engine registered for %@ (view not mounted yet?)", engineId);
    return;
  }
  std::vector<std::string> batch;
  batch.reserve(envelopes.count);
  for (id item in envelopes) {
    if ([item isKindOfClass:[NSString class]]) batch.emplace_back([(NSString *)item UTF8String]);
  }
  engine->postMessages(batch);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeMapramaEngineModuleSpecJSI>(params);
}

@end
