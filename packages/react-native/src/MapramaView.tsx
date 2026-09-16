/**
 * @module
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { CameraSpec, InitCommand, LabelContent, LabelInfo, LabelsSpec } from '@maprama/protocol';
import { CommandBatcher } from './batching';
import { MapContext, notifyMapMountChange, type MapContextValue } from './context';
import type { EngineHost, EngineHostError } from './host/EngineHost';
import { DEFAULT_ENGINE_HOST, getEngineHost } from './host/registry';
import { planLocation, startExpoLocationWatch } from './location/device';
import { MapController } from './ref';
import type { MapramaLabelsProps, MapramaViewProps, MapramaViewRef, LabelContentFunction } from './types';

/** @internal Converts the `labels` prop to the protocol spec (a content function becomes `'custom'`). */
export function toLabelsSpec(labels: MapramaLabelsProps | undefined): LabelsSpec {
  if (!labels) return {};
  const { content, ...rest } = labels;
  if (content === undefined) return rest;
  return { ...rest, content: typeof content === 'function' ? 'custom' : content };
}

/** @internal Fields of `next` that differ from `prev`; `follow` removal becomes `null`. `null` when nothing changed. */
export function diffCamera(prev: CameraSpec | undefined, next: CameraSpec | undefined): CameraSpec | null {
  const a = prev ?? {};
  const b = next ?? {};
  const diff: Record<string, unknown> = {};
  const keys = ['center', 'distance', 'zoom', 'pitch', 'bearing', 'follow', 'minDistanceMeters', 'maxDistanceMeters'] as const;
  for (const key of keys) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    if (b[key] === undefined) {
      if (key === 'follow' && a.follow !== undefined && a.follow !== null) diff.follow = null;
      continue;
    }
    diff[key] = b[key];
  }
  if (Object.keys(diff).length === 0) return null;
  if (b.animate !== undefined) diff.animate = b.animate;
  return diff as CameraSpec;
}

function evaluateLabelContent(fn: LabelContentFunction, labels: LabelInfo[]): Record<string, LabelContent> {
  const entries: Record<string, LabelContent> = {};
  for (const label of labels) {
    const content = fn(label);
    entries[label.id] = content ?? { title: label.name };
  }
  return entries;
}

interface SentState {
  theme: string;
  labels: string;
  ui: string;
  camera: CameraSpec | undefined;
  locationSource: string;
}

interface Internals extends MapContextValue {
  sent: SentState;
  labelsIndex: { current: LabelInfo[] | null };
  /** Evaluates the latest `labels.content` function against the latest index (no-op otherwise). */
  refreshLabels: () => void;
}

/**
 * The 2.5D game map. Hosts the engine (a WebView running `@maprama/engine-web`
 * by default), sends `init` once the engine is ready and turns prop changes and
 * children into minimal protocol commands.
 *
 * ```tsx
 * const map = useRef<MapramaViewRef>(null);
 * <MapramaView ref={map} world={{ kind: 'procedural', layout: 'town' }} theme={{ base: 'urban', timeOfDay: 'golden' }}
 *   camera={{ pitch: 45, distance: 60, follow: 'me' }} location={{ source: 'device' }} style={{ flex: 1 }}>
 *   <Character id="me" isPlayer follow="location" />
 * </MapramaView>
 * ```
 */
export const MapramaView = forwardRef<MapramaViewRef, MapramaViewProps>(function MapramaView(props, ref) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const locationPlan = planLocation(props.location);
  const planRef = useRef(locationPlan);
  planRef.current = locationPlan;

  const [internals] = useState<Internals>(() => {
    const sent: SentState = { theme: '', labels: '', ui: '', camera: undefined, locationSource: '' };
    const labelsIndex: { current: LabelInfo[] | null } = { current: null };
    let batcher: CommandBatcher | null = null;
    const refreshLabels = (): void => {
      const content = propsRef.current.labels?.content;
      const index = labelsIndex.current;
      if (typeof content !== 'function' || !index || !batcher) return;
      let entries: Record<string, LabelContent>;
      try {
        entries = evaluateLabelContent(content, index);
      } catch (e) {
        propsRef.current.onError?.({
          code: 'listener_error',
          message: `labels.content threw: ${e instanceof Error ? e.message : String(e)}`,
          fatal: false,
        });
        return;
      }
      batcher.setLabelContent(entries);
    };
    const controller = new MapController({
      buildInit: (): InitCommand => {
        const p = propsRef.current;
        const theme = p.theme ?? {};
        const labels = toLabelsSpec(p.labels);
        const ui = p.ui ?? {};
        const locationSource = planRef.current.engineSource;
        sent.theme = JSON.stringify(theme);
        sent.labels = JSON.stringify(labels);
        sent.ui = JSON.stringify(ui);
        sent.camera = p.camera;
        sent.locationSource = locationSource;
        return { type: 'init', world: p.world, theme, labels, ui, ...(p.camera ? { camera: p.camera } : {}), locationSource };
      },
      onReady: (engine, isReload) => {
        if (isReload) batcher?.resetSent();
        batcher?.flushNow();
        propsRef.current.onReady?.({ engine });
      },
      onError: (error) => propsRef.current.onError?.(error),
      beforeImperativeSend: () => batcher?.flushNow(),
      // Read from the latest props whenever a timer is armed.
      getTimeouts: () => ({
        requestTimeoutMs: propsRef.current.requestTimeoutMs,
        travelStartTimeoutMs: propsRef.current.travelStartTimeoutMs,
      }),
      getTravelTimeScale: () => propsRef.current.travelTimeScale,
      refreshLabelContent: refreshLabels,
    });
    batcher = new CommandBatcher({
      sink: (command) => controller.sendCommand(command),
      canFlush: () => controller.isReady(),
    });
    return { controller, batcher, overlayListeners: new Map(), sent, labelsIndex, refreshLabels };
  });
  const { controller, batcher, sent, labelsIndex, overlayListeners, refreshLabels } = internals;

  useImperativeHandle(ref, () => controller, [controller]);

  // Lets hooks holding a ref object (e.g. useCharacterPosition(mapRef)) pick up a map that mounts after them.
  useEffect(() => {
    notifyMapMountChange();
    return () => notifyMapMountChange();
  }, [controller]);

  // Engine events handled by the map itself.
  useEffect(() => {
    const offs = [
      controller.addEventListener('map:press', (e) => propsRef.current.onPress?.({ coordinate: e.coordinate })),
      controller.addEventListener('building:press', (e) =>
        propsRef.current.onBuildingPress?.({ buildingId: e.buildingId, coordinate: e.coordinate }),
      ),
      controller.addEventListener('labelsIndex', (e) => {
        labelsIndex.current = e.labels;
        refreshLabels();
      }),
      controller.addEventListener('overlay:positions', (e) => {
        for (const position of e.positions) overlayListeners.get(position.id)?.(position);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [controller, labelsIndex, overlayListeners, refreshLabels]);

  useEffect(
    () => () => {
      batcher.dispose();
      controller.dispose();
    },
    [batcher, controller],
  );

  // Prop changes after init → minimal commands (before init they are folded into `init`).
  useEffect(() => {
    if (!controller.isReady()) return;
    const theme = props.theme ?? {};
    const themeJson = JSON.stringify(theme);
    if (themeJson !== sent.theme) {
      sent.theme = themeJson;
      controller.sendCommand({ type: 'setTheme', theme });
    }
    const labels = toLabelsSpec(props.labels);
    const labelsJson = JSON.stringify(labels);
    if (labelsJson !== sent.labels) {
      sent.labels = labelsJson;
      controller.sendCommand({ type: 'setLabels', labels });
      // Non-function label fields changed: re-evaluate a content function once.
      refreshLabels();
    }
    const ui = props.ui ?? {};
    const uiJson = JSON.stringify(ui);
    if (uiJson !== sent.ui) {
      sent.ui = uiJson;
      controller.sendCommand({ type: 'setUi', ui });
    }
    const cameraDiff = diffCamera(sent.camera, props.camera);
    sent.camera = props.camera;
    if (cameraDiff) controller.sendCommand({ type: 'setCamera', camera: cameraDiff });
    if (locationPlan.engineSource !== sent.locationSource) {
      sent.locationSource = locationPlan.engineSource;
      controller.sendCommand({ type: 'setLocationSource', source: locationPlan.engineSource });
    }
  });

  // Device location through expo-location.
  useEffect(() => {
    if (!locationPlan.useExpoLocation) return undefined;
    return startExpoLocationWatch(
      (fix) => controller.pushLocation(fix),
      (code, message) => propsRef.current.onError?.({ code, message, fatal: false }),
    );
  }, [controller, locationPlan.useExpoLocation]);

  const onHost = useCallback((host: EngineHost) => controller.attachHost(host), [controller]);
  // Fatal host failures also reject pending requests/travel (they would never settle).
  const onHostError = useCallback(
    (error: EngineHostError) => controller.reportHostError({ code: error.code, message: error.message, fatal: error.fatal }),
    [controller],
  );

  const [engineKind] = useState(() => props.engine ?? DEFAULT_ENGINE_HOST);
  const Host = getEngineHost(engineKind);
  useEffect(() => {
    if (!Host) {
      controller.reportHostError({ code: 'unsupported', message: `no engine host registered for "${engineKind}"`, fatal: true });
    }
  }, [Host, engineKind, controller]);

  return (
    <View style={[styles.container, props.style]} testID={props.testID}>
      {Host ? (
        <Host
          style={StyleSheet.absoluteFill}
          onHost={onHost}
          onHostError={onHostError}
          options={{ geolocationEnabled: locationPlan.webViewGeolocation, testID: props.testID ? `${props.testID}-engine` : undefined }}
        />
      ) : null}
      <MapContext.Provider value={internals}>
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {props.children}
        </View>
      </MapContext.Provider>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
