// Maprama native engine — TurboModule (`MapramaEngineModule`, codegen spec `NativeMapramaEngineModule.ts`).
//
// `postMessage` / `postMessages` look the engine up in `maprama::EngineRegistry` and hand it the envelope
// text; engine events come back through the codegen EventEmitter `onEngineEvent` (DESIGN.md §4.1, M1).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface MapramaEngineEvents : NSObject
/// Delivers one encoded event envelope of `engineId` to JS. Safe from any thread. Events emitted before the
/// module's JS object exists are buffered (bounded) and flushed once it does.
+ (void)emitEnvelope:(NSString *)envelope engineId:(NSString *)engineId;
@end

NS_ASSUME_NONNULL_END
