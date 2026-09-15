// Registers the `native` engine host (C++ core + MapLibre Native) with @maprama/react-native.
import '@maprama/engine-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Character, DropLayer, Geofence, useCameraState, type MapramaViewRef } from '@maprama/react-native';
import { ZOOM_OUT_BEHAVIORS, type DropType, type LngLat, type Rarity, type ZoomOutBehavior } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SAMPLE_CHARACTER_MODEL_URI } from '../src/data/sampleModel';
import { SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

// M4: the zoom-out game view (theme.zoomOut), the performance scene of DESIGN.md §8 (50 characters, 200 drops,
// 20 geofences, orbiting camera) and an engine toggle to compare engine-web and engine-native on the same scene.

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;
const ENGINES = ['native', 'web'] as const;
type EngineChoice = (typeof ENGINES)[number];
const LOADS = ['light', 'perf'] as const;
type LoadChoice = (typeof LOADS)[number];
const LOAD_LABELS: Record<LoadChoice, string> = { light: 'light (2 characters)', perf: 'perf (50 · 200 · 20)' };

const UNIT = SEONGSU_WORLD.unitMeters;
/** engine-web `zoomOutTarget`: 0 below 55 world units, 1 from 110 (D1 / D2), smoothstepped. */
const D1 = 55;
const D2 = 110;
const DEMO_TIME_SCALE = 20;
const START = offsetMeters(STATION, -40, -30);
const NEAR_CAMERA = { center: STATION, distance: 320, pitch: 50, bearing: 0 };
/** Beyond D2 (1,150 m = 144 world units at 8 m per unit; the distance limit is 150 units). */
const FAR_CAMERA = { center: STATION, distance: 1150, pitch: 50, bearing: 0 };

/** Deterministic pseudo-random number in [0, 1) (scene layout, no Math.random: both engines get the same scene). */
function rand(seed: number): number {
  const a = Math.sin(seed * 12.9898 + 4.1414) * 43758.5453;
  return a - Math.floor(a);
}

function scatter(center: LngLat, seed: number, radius: number): LngLat {
  return offsetMeters(center, (rand(seed) * 2 - 1) * radius, (rand(seed + 0.5) * 2 - 1) * radius);
}

interface PerfDrop {
  id: string;
  type: DropType;
  rarity: Rarity;
  value: number;
  coordinate: LngLat;
}

const DROP_TYPES: DropType[] = ['coin', 'coin', 'cd', 'vinyl', 'note'];
const RARITIES: Rarity[] = ['common', 'common', 'common', 'rare', 'legendary'];

/** 200 drops within ≈260 m of the station (nobody collects them). */
const PERF_DROPS: PerfDrop[] = Array.from({ length: 200 }, (_, i) => ({
  id: `perf-drop-${i}`,
  type: DROP_TYPES[i % DROP_TYPES.length]!,
  rarity: RARITIES[Math.floor(rand(i + 300) * RARITIES.length)]!,
  value: i % 7 === 0 ? 80 : 10,
  coordinate: scatter(STATION, i + 1000, 260),
}));

/** 20 geofences (radius 20–45 m) around the station. */
const PERF_FENCES = Array.from({ length: 20 }, (_, i) => ({
  id: `perf-fence-${i}`,
  center: scatter(STATION, i + 2000, 240),
  radiusMeters: 20 + Math.round(rand(i + 2100) * 25),
}));

const PERF_WALKERS = 49;

/** engine-web `zoomOutTarget` for the readout. */
function zoomTarget(behavior: ZoomOutBehavior, distanceMeters: number): number {
  if (behavior === 'none') return 0;
  const x = Math.min(1, Math.max(0, (distanceMeters / UNIT - D1) / D1));
  return x * x * (3 - 2 * x);
}

const fixed = (value: number, digits: number) => value.toFixed(digits);

export default function NativeM4Screen() {
  const [engine, setEngine] = useState<EngineChoice>('native');
  // A new engine remounts the map (the host is chosen at mount), so both engines start from the same scene.
  return <M4Scene key={engine} engine={engine} onEngineChange={setEngine} />;
}

function M4Scene({ engine, onEngineChange }: { engine: EngineChoice; onEngineChange: (choice: EngineChoice) => void }) {
  const mapRef = useRef<MapramaViewRef>(null);
  const camera = useCameraState(mapRef, { throttleMs: 100 });
  const [zoomOut, setZoomOut] = useState<ZoomOutBehavior>('keepGameView');
  const [load, setLoad] = useState<LoadChoice>('light');
  const [log, pushLog] = useEventLog();
  const generation = useRef(0);

  const walkers = useMemo(() => (load === 'perf' ? Array.from({ length: PERF_WALKERS }, (_, i) => `crowd-${i}`) : []), [load]);

  // The crowd walks between scattered points within ≈120 m of START (walk ×20), re-travelling on every arrival.
  useEffect(() => {
    const gen = ++generation.current;
    const api = mapRef.current;
    if (!api || walkers.length === 0) return undefined;
    let hop = 0;
    const walk = (id: string, seed: number) => {
      if (gen !== generation.current) return;
      api
        .travel(id, scatter(START, seed + hop++ * 97, 120), ['walk'], { timeoutMs: 10 * 60_000 })
        .then(() => walk(id, seed + 1))
        .catch(() => undefined);
    };
    const timer = setTimeout(() => walkers.forEach((id, i) => walk(id, i * 13 + 1)), 50);
    return () => clearTimeout(timer);
  }, [walkers]);

  const move = (title: string, spec: Parameters<MapramaViewRef['setCamera']>[0]) => {
    mapRef.current?.setCamera(spec);
    pushLog(`setCamera: ${title}`);
  };

  const distance = camera?.distance ?? NEAR_CAMERA.distance;
  const units = distance / UNIT;
  const t = zoomTarget(zoomOut, distance);
  const band = units < D1 ? 'near (< D1)' : units < D2 ? 'band (D1–D2)' : 'far (≥ D2)';
  const characters = 2 + walkers.length;

  return (
    <ScreenLayout
      map={
        <DemoMap
          engine={engine}
          mapRef={mapRef}
          world={WORLD}
          theme={{ base: 'modern', timeOfDay: 'day', zoomOut }}
          ui={{ zoomButtons: true }}
          location={{ source: 'simulated' }}
          travelTimeScale={DEMO_TIME_SCALE}
          camera={NEAR_CAMERA}
          onReady={(e) => pushLog(`ready: ${e.engine.name} (${e.engine.kind})`)}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <Character id="me" isPlayer name="Traveller" color="#E0457B" follow="none" position={START} />
          <Character id="walker" name="Walker" color="#D3A03E" follow="location" model={SAMPLE_CHARACTER_MODEL_URI} />
          {walkers.map((id, i) => (
            <Character key={id} id={id} follow="none" position={scatter(START, i * 13 + 1, 100)} model={i % 2 === 0 ? SAMPLE_CHARACTER_MODEL_URI : undefined} />
          ))}
          {load === 'perf' ? (
            <DropLayer
              id="perf-drops"
              data={PERF_DROPS}
              getId={(d) => d.id}
              getCoordinate={(d) => d.coordinate}
              getType={(d) => d.type}
              getRarity={(d) => d.rarity}
              getValue={(d) => d.value}
              collectorIds={[]}
              collectRadiusMeters={1}
            />
          ) : null}
          {load === 'perf'
            ? PERF_FENCES.map((f) => <Geofence key={f.id} id={f.id} center={f.center} radiusMeters={f.radiusMeters} />)
            : null}
        </DemoMap>
      }
    >
      <Readout testID="m4-camera">
        {camera ? `camera: ${fixed(distance, 0)} m = ${fixed(units, 1)} units · pitch ${fixed(camera.pitch, 0)}° · bearing ${fixed(camera.bearing, 0)}°` : 'camera: waiting for camera:change'}
      </Readout>
      <Readout testID="m4-zoom-state">{`zoomOut: ${zoomOut} · ${band} · web target t ${fixed(t, 2)}`}</Readout>
      <Readout testID="m4-load-state">{`engine: ${engine} · load: ${load} · ${characters} characters · ${load === 'perf' ? PERF_DROPS.length : 0} drops · ${load === 'perf' ? PERF_FENCES.length : 0} geofences`}</Readout>
      <Section title="Zoom-out (theme.zoomOut)">
        <Chips options={ZOOM_OUT_BEHAVIORS} value={zoomOut} onChange={setZoomOut} testIDPrefix="m4-zoom" />
        <ButtonRow>
          <Button testID="m4-near" title="Near (320 m)" onPress={() => move('near', { ...NEAR_CAMERA, animate: true })} />
          <Button testID="m4-far" title="Far (1,150 m)" onPress={() => move('far', { ...FAR_CAMERA, animate: { durationMs: 900 } })} />
          <Button
            testID="m4-orbit"
            title="Orbit 8 s"
            onPress={() => move('orbit 180° over 8 s', { bearing: (camera?.bearing ?? 0) + 180, animate: { durationMs: 8000 } })}
          />
        </ButtonRow>
      </Section>
      <Section title="Performance scene (DESIGN.md §8)">
        <Chips options={LOADS} value={load} onChange={setLoad} testIDPrefix="m4-load" labels={LOAD_LABELS} />
      </Section>
      <Section title="Engine (parity)">
        <Chips options={ENGINES} value={engine} onChange={onEngineChange} testIDPrefix="m4-engine" />
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="m4-log" />
      </Section>
    </ScreenLayout>
  );
}
