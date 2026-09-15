/**
 * Codegen spec of the `MapramaNativeView` Fabric component: hosts the MapLibre map and owns one native
 * engine, registered under `engineId`. Commands and events never travel through view props or view
 * events — only through `MapramaEngineModule` (DESIGN.md §2).
 *
 * @module
 */

import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';

export interface NativeProps extends ViewProps {
  /** Id the view registers its engine under (`MapramaEngineModule.postMessage(engineId, …)`). */
  engineId: string;
}

export default codegenNativeComponent<NativeProps>('MapramaNativeView') as HostComponent<NativeProps>;
