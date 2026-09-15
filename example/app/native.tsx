// Registers the `native` engine host (C++ core + MapLibre Native) with @maprama/react-native.
import '@maprama/engine-native';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  PRESET_NAMES,
  TIMES_OF_DAY,
  haversineMeters,
  type CameraSpec,
  type PresetName,
  type TimeOfDay,
  type WorldSource,
} from '@maprama/protocol';
import { MapOverlay, useCameraState, type MapramaViewRef } from '@maprama/react-native';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SAMPLE_BUILDING, SEONGSU_WORLD, STATION, STATION_NAME, offsetMeters } from '../src/data/seongsu';

// World sources (the web catalog's world screen is the reference): the bundled Seongsu data or a world the
// C++ core generates with its port of engine-web's procedural generators (same seed -> same world).
const SOURCES = ['data', 'town', 'grid'] as const;
type SourceChoice = (typeof SOURCES)[number];
const PROCEDURAL_SEED = 7;
const WORLDS: Record<SourceChoice, WorldSource> = {
  data: { kind: 'data', world: SEONGSU_WORLD },
  town: { kind: 'procedural', layout: 'town', seed: PROCEDURAL_SEED },
  grid: { kind: 'procedural', layout: 'grid', seed: PROCEDURAL_SEED },
};
const SOURCE_LABELS: Record<SourceChoice, string> = { data: 'data (Seongsu)', town: 'procedural town', grid: 'procedural grid' };
const STATION_CARD = 'station-card';
const CAPTURED_COLOR = '#FF8800';

const PRESETS: { id: string; title: string; camera: CameraSpec }[] = [
  { id: 'station', title: 'Station', camera: { center: STATION, distance: 300, pitch: 50, bearing: 0, animate: true } },
  { id: 'top', title: 'Top-down', camera: { center: STATION, distance: 900, pitch: 0, bearing: 0, animate: true } },
  {
    id: 'tilt',
    title: 'Tilted 60°',
    camera: { center: offsetMeters(STATION, 250, -150), distance: 250, pitch: 60, bearing: 120, animate: { durationMs: 900 } },
  },
];

const fixed = (value: number, digits: number) => value.toFixed(digits);

export default function NativeEngineScreen() {
  const [source, setSource] = useState<SourceChoice>('data');
  // `world` is read at init: a new source remounts the screen, so the map, its subscriptions and readouts start fresh.
  return <NativeEngineWorld key={source} source={source} onSourceChange={setSource} />;
}

function NativeEngineWorld({ source, onSourceChange }: { source: SourceChoice; onSourceChange: (choice: SourceChoice) => void }) {
  const real = source === 'data';
  const mapRef = useRef<MapramaViewRef>(null);
  const camera = useCameraState(mapRef, { throttleMs: 100 });
  const [projection, setProjection] = useState('project: not run yet');
  const [preset, setPreset] = useState<PresetName>(real ? 'realistic' : 'toy');
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>('day');
  const [picked, setPicked] = useState('picked: none');
  const [mapPress, setMapPress] = useState('map:press: none yet');
  const [buildingPress, setBuildingPress] = useState('building:press: none yet');
  const [overlay, setOverlay] = useState('overlay: waiting for overlay:positions');
  const [log, pushLog] = useEventLog();

  // Readout of the station card's anchor (overlay:positions drives the <MapOverlay> itself).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    let last = 0;
    return map.addEventListener('overlay:positions', (e) => {
      const p = e.positions.find((it) => it.id === STATION_CARD);
      const now = Date.now();
      if (!p || now - last < 250) return;
      last = now;
      setOverlay(`overlay: x ${fixed(p.x, 0)}, y ${fixed(p.y, 0)}${p.visible ? ' (visible)' : ' (off-screen)'}`);
    });
  }, []);

  const roundTrip = async () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const point = await map.project(STATION);
      const back = await map.unproject(point);
      const error = back ? `${fixed(haversineMeters(STATION, back), 2)} m` : 'miss';
      setProjection(
        `project: x ${fixed(point.x, 1)}, y ${fixed(point.y, 1)}${point.visible ? ' (visible)' : ' (off-screen)'} → unproject: ${
          back ? `${fixed(back.lng, 5)}, ${fixed(back.lat, 5)}` : 'null'
        } (Δ ${error})`,
      );
      pushLog(`project/unproject round trip, Δ ${error}`);
    } catch (e) {
      setProjection(`project failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const pickBuilding = () => {
    if (!SAMPLE_BUILDING) return;
    mapRef.current?.setBuildingStyle(SAMPLE_BUILDING.id, { color: CAPTURED_COLOR, state: 'captured' });
    mapRef.current?.setCamera({ center: SAMPLE_BUILDING.coordinate, distance: 220, pitch: 45, bearing: 0, animate: true });
    setPicked(`picked: ${SAMPLE_BUILDING.id} (captured, ${CAPTURED_COLOR})`);
    pushLog(`setBuildingStyle ${SAMPLE_BUILDING.id}: captured ${CAPTURED_COLOR}`);
  };

  const resetBuilding = () => {
    if (!SAMPLE_BUILDING) return;
    mapRef.current?.setBuildingStyle(SAMPLE_BUILDING.id, null);
    setPicked('picked: none');
    pushLog(`setBuildingStyle ${SAMPLE_BUILDING.id}: null`);
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          engine="native"
          mapRef={mapRef}
          world={WORLDS[source]}
          theme={{ base: preset, timeOfDay }}
          ui={{ zoomButtons: true }}
          // Procedural worlds keep the default framing (the generator's start point, like engine-web).
          camera={real ? { center: STATION, pitch: 45, distance: 400 } : { pitch: 45, distance: 400 }}
          onReady={(e) => pushLog(`ready: ${e.engine.name} ${e.engine.version} (${e.engine.kind})`)}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
          onPress={(e) => {
            setMapPress(`map:press: ${fixed(e.coordinate.lng, 5)}, ${fixed(e.coordinate.lat, 5)}`);
            pushLog('map:press');
          }}
          onBuildingPress={(e) => {
            setBuildingPress(`building:press: ${e.buildingId} @ ${fixed(e.coordinate.lng, 5)}, ${fixed(e.coordinate.lat, 5)}`);
            pushLog(`building:press ${e.buildingId}`);
          }}
        >
          {real ? (
            <MapOverlay id={STATION_CARD} coordinate={STATION} anchor="bottom" offset={{ x: 0, y: -10 }} pointerEvents="none">
              <View style={styles.card}>
                <Text testID="native-overlay-card" style={styles.cardTitle}>
                  {STATION_NAME} Station
                </Text>
                <Text style={styles.cardText}>MapOverlay · native engine</Text>
              </View>
            </MapOverlay>
          ) : null}
        </DemoMap>
      }
    >
      <Section title="Camera (camera:change)">
        <Readout testID="native-camera">
          {camera
            ? `camera: ${fixed(camera.center.lng, 5)}, ${fixed(camera.center.lat, 5)} · ${fixed(camera.distance, 0)} m · pitch ${fixed(
                camera.pitch,
                0,
              )}° · bearing ${fixed(camera.bearing, 0)}°`
            : 'camera: waiting for camera:change'}
        </Readout>
        <ButtonRow>
          {PRESETS.map((item) => (
            <Button
              key={item.id}
              testID={`native-preset-${item.id}`}
              title={item.title}
              // Presets that jump to a Seongsu centre only make sense on the Seongsu data world.
              disabled={!real && 'center' in item.camera}
              onPress={() => {
                mapRef.current?.setCamera(item.camera);
                pushLog(`setCamera: ${item.title}`);
              }}
            />
          ))}
        </ButtonRow>
      </Section>
      <Section title="project / unproject">
        <ButtonRow>
          <Button testID="native-project" title="Round trip the station" disabled={!real} onPress={roundTrip} />
        </ButtonRow>
        <Readout testID="native-project-result">{projection}</Readout>
      </Section>
      <Section title="Buildings and presses">
        <ButtonRow>
          <Button
            testID="native-pick-building"
            title={`Pick sample building${SAMPLE_BUILDING ? ` (${SAMPLE_BUILDING.name})` : ''}`}
            disabled={!SAMPLE_BUILDING || !real}
            onPress={pickBuilding}
          />
          <Button testID="native-reset-building" title="Reset style" disabled={!real} onPress={resetBuilding} />
          <Button
            testID="native-station-view"
            title="Station view"
            disabled={!real}
            onPress={() => {
              mapRef.current?.setCamera({ center: STATION, distance: 300, pitch: 50, bearing: 0, animate: true });
              pushLog('setCamera: station view');
            }}
          />
        </ButtonRow>
        <Readout testID="native-picked">{picked}</Readout>
        <Readout testID="native-building-press">{buildingPress}</Readout>
        <Readout testID="native-map-press">{mapPress}</Readout>
        <Readout testID="native-overlay-state">{overlay}</Readout>
      </Section>
      <Section title="Theme (setTheme)">
        <Chips label="Preset" options={PRESET_NAMES} value={preset} onChange={setPreset} testIDPrefix="native-theme" />
        <Chips label="Time of day" options={TIMES_OF_DAY} value={timeOfDay} onChange={setTimeOfDay} testIDPrefix="native-time" />
        <Readout testID="native-theme-state">{`theme: ${preset} · ${timeOfDay}`}</Readout>
      </Section>
      <Section title="World source (init.world)">
        <Chips options={SOURCES} value={source} onChange={onSourceChange} testIDPrefix="native-world" labels={SOURCE_LABELS} />
        <Readout testID="native-world-state">
          {real
            ? `world: data (Seongsu OSM sample, ${SEONGSU_WORLD.buildings.length} buildings)`
            : `world: procedural ${source}, seed ${PROCEDURAL_SEED} (generated by the C++ core)`}
        </Readout>
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="native-log" />
      </Section>
    </ScreenLayout>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#94a3b8',
    alignItems: 'center',
  },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#1e3a8a' },
  cardText: { fontSize: 10, color: '#475569' },
});
