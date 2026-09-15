/**
 * Codegen spec of the `MapramaEngineModule` TurboModule (iOS `MapramaEngineModule.mm`, Android
 * `MapramaEngineModule.kt`). M1 transport (DESIGN.md §4.1): commands go in as encoded envelope strings
 * (`postMessage` / `postMessages`), events come back through the codegen `EventEmitter`
 * `onEngineEvent`, one encoded envelope per emission, tagged with the engine id.
 *
 * @module
 */

import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** One event envelope (`encodeEvent` output) from the engine with id `engineId`. */
export type EngineEventMessage = {
  engineId: string;
  envelope: string;
};

export interface Spec extends TurboModule {
  /** Delivers one command envelope (`encodeCommand` output) to the engine `engineId`. */
  postMessage(engineId: string, envelope: string): void;
  /** Delivers several command envelopes in order (one JSI crossing per JS task). */
  postMessages(engineId: string, envelopes: ReadonlyArray<string>): void;
  /** Engine events of every native engine; filter by `engineId`. */
  readonly onEngineEvent: CodegenTypes.EventEmitter<EngineEventMessage>;
}

/** `null` when the native module is not linked (e.g. Expo Go or a web-only build). */
export default TurboModuleRegistry.get<Spec>('MapramaEngineModule');
