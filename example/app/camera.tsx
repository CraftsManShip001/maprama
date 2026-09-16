import { useMemo, useRef, useState } from 'react';
import { MarkerLayer, useCameraState, visibleSpanMeters, type LngLatBounds, type MapramaViewRef } from '@maprama/react-native';
import type { LngLat } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

/** The engine default: 150 world units at the sample's 8 m per unit. */
const DEFAULT_MAX_METERS = 1200;
/** What the first integrator's opening screen needs. */
const WIDE_MAX_METERS = 3330;
/** Closest the camera may come; low enough to walk an alley at either setting. */
const MIN_METERS = 60;

interface Pin {
  id: string;
  title: string;
  coordinate: LngLat;
}

/**
 * 18 pins on a ring 1.6 km across — the integrator's opening screen. The default
 * 1,200 m ceiling shows about 874 m of ground at the target, so most of them are
 * off screen; at 3,330 m the whole ring fits with room to spare.
 */
const PINS: Pin[] = Array.from({ length: 18 }, (_, i) => {
  const angle = (i / 18) * Math.PI * 2;
  const radius = 300 + (i % 3) * 250;
  return {
    id: `pin-${i + 1}`,
    title: `Spot ${i + 1}`,
    coordinate: offsetMeters(STATION, Math.cos(angle) * radius, Math.sin(angle) * radius),
  };
});

const PIN_BOUNDS: LngLatBounds = {
  sw: {
    lng: Math.min(...PINS.map((p) => p.coordinate.lng)),
    lat: Math.min(...PINS.map((p) => p.coordinate.lat)),
  },
  ne: {
    lng: Math.max(...PINS.map((p) => p.coordinate.lng)),
    lat: Math.max(...PINS.map((p) => p.coordinate.lat)),
  },
};

const RANGES = ['default', 'wide'] as const;
type Range = (typeof RANGES)[number];

const MAX_OF: Record<Range, number> = { default: DEFAULT_MAX_METERS, wide: WIDE_MAX_METERS };

export default function CameraScreen() {
  const map = useRef<MapramaViewRef>(null);
  const [range, setRange] = useState<Range>('default');
  const [onScreen, setOnScreen] = useState<number | null>(null);
  const [fit, setFit] = useState<string>('—');
  const [log, pushLog] = useEventLog();
  const camera = useCameraState(map, { throttleMs: 120 });

  const maxMeters = MAX_OF[range];
  const distance = camera?.distance ?? null;
  // A stable object: only the changed fields of the camera prop are sent (`diffCamera`).
  const cameraProp = useMemo(
    () => ({
      center: STATION,
      pitch: 45,
      bearing: 0,
      distance: 900,
      minDistanceMeters: MIN_METERS,
      maxDistanceMeters: maxMeters,
    }),
    [maxMeters],
  );

  /** Counts the pins the engine reports as on screen (the integrator's "5 of 18"). */
  const countOnScreen = async () => {
    const api = map.current;
    if (!api) return;
    try {
      const points = await Promise.all(PINS.map((p) => api.project(p.coordinate)));
      const n = points.filter((p) => p.visible).length;
      setOnScreen(n);
      pushLog(`${n} of ${PINS.length} pins on screen at ${Math.round(distance ?? 0)} m`);
    } catch (e) {
      pushLog(`project failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const zoomOut = () => {
    // Asking for more than the ceiling is the point: the engine clamps to the limit in metres.
    map.current?.setCamera({ center: STATION, distance: 99999, animate: true });
    pushLog(`zoom out to the ${maxMeters} m ceiling`);
  };

  const fitPins = async () => {
    const api = map.current;
    if (!api) return;
    try {
      const result = await api.fitBounds(PIN_BOUNDS, {
        padding: { top: 40, right: 24, bottom: 40, left: 24 },
        animate: true,
      });
      setFit(`${result.fitted ? 'fitted' : 'does not fit'} at ${Math.round(result.camera.distance)} m`);
      pushLog(
        `fitBounds → ${Math.round(result.camera.distance)} m, pitch ${Math.round(result.camera.pitch)}°, ` +
          `fitted: ${result.fitted}, distanceLimited: ${result.distanceLimited}`,
      );
      setOnScreen(null);
    } catch (e) {
      pushLog(`fitBounds failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const span = distance === null ? null : Math.round(visibleSpanMeters(distance));

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'urban', timeOfDay: 'day', zoomOut: 'keepGameView' }}
          labels={{ style: 'app' }}
          camera={cameraProp}
          location={{ source: 'external' }}
          onError={(e) => pushLog(`error ${e.code}${e.fatal ? ' (fatal)' : ''}: ${e.message}`)}
        >
          <MarkerLayer
            id="pins"
            data={PINS}
            getId={(p) => p.id}
            getCoordinate={(p) => p.coordinate}
            getColor={() => '#E0452F'}
            getAccessibilityLabel={(p) => p.title}
            size={34}
          />
        </DemoMap>
      }
    >
      <Readout testID="camera-distance">distance: {distance === null ? '—' : `${Math.round(distance)} m`}</Readout>
      <Readout testID="camera-span">visible span: {span === null ? '—' : `${span} m`} (40° field of view)</Readout>
      <Readout testID="camera-max">maxDistanceMeters: {maxMeters} m</Readout>
      <Readout testID="camera-onscreen">
        pins on screen: {onScreen === null ? '—' : `${onScreen} of ${PINS.length}`}
      </Readout>
      <Readout testID="camera-fit">fitBounds: {fit}</Readout>
      <Section title="Distance ceiling in metres (independent of the world's unitMeters)">
        <Chips
          label="range"
          options={RANGES}
          value={range}
          onChange={setRange}
          testIDPrefix="camera-range"
          labels={{ default: 'default 1,200 m', wide: 'wide 3,330 m' }}
        />
        <ButtonRow>
          <Button title="Zoom out to the ceiling" testID="camera-zoom-out" onPress={zoomOut} />
          <Button title="Count pins on screen" testID="camera-count" onPress={() => void countOnScreen()} />
        </ButtonRow>
      </Section>
      <Section title="fitBounds: frame all 18 pins">
        <ButtonRow>
          <Button title="Fit the pins" testID="camera-fit-pins" onPress={() => void fitPins()} />
          <Button
            title="Back to street level"
            testID="camera-street"
            onPress={() => map.current?.setCamera({ center: STATION, distance: MIN_METERS, pitch: 45, animate: true })}
          />
        </ButtonRow>
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="camera-log" />
      </Section>
    </ScreenLayout>
  );
}
