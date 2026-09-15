// Registers the `native` engine host (C++ core + MapLibre Native) with @maprama/react-native.
import '@maprama/engine-native';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  PRESET_NAMES,
  ROOF_SHAPES,
  TIMES_OF_DAY,
  haversineMeters,
  type BuildingStyle,
  type CameraSpec,
  type PresetName,
  type RoofShape,
  type TimeOfDay,
  type WorldSource,
} from '@maprama/protocol';
import { MapOverlay, useCameraState, type MapramaViewRef } from '@maprama/react-native';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SAMPLE_BUILDING, SEONGSU_WORLD, STATION, STATION_NAME, offsetMeters } from '../src/data/seongsu';

const WORLD: WorldSource = { kind: 'data', world: SEONGSU_WORLD };
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

const FACADE_OPTIONS = ['on', 'off'] as const;
type FacadeOption = (typeof FACADE_OPTIONS)[number];

/** The sample building's style: M2a captured colour plus the M2c roof / facade (setBuildingStyle replaces it whole). */
function sampleStyle(captured: boolean, roof: RoofShape, facade: FacadeOption): BuildingStyle {
  const style: BuildingStyle = { roof, facade: facade === 'on' };
  if (captured) {
    style.color = CAPTURED_COLOR;
    style.state = 'captured';
  }
  return style;
}

const fixed = (value: number, digits: number) => value.toFixed(digits);

export default function NativeEngineScreen() {
  const mapRef = useRef<MapramaViewRef>(null);
  const camera = useCameraState(mapRef, { throttleMs: 100 });
  const [projection, setProjection] = useState('project: not run yet');
  const [preset, setPreset] = useState<PresetName>('realistic');
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>('day');
  const [picked, setPicked] = useState('picked: none');
  const [mapPress, setMapPress] = useState('map:press: none yet');
  const [buildingPress, setBuildingPress] = useState('building:press: none yet');
  const [overlay, setOverlay] = useState('overlay: waiting for overlay:positions');
  const [captured, setCaptured] = useState(false);
  const [roof, setRoof] = useState<RoofShape>('flat');
  const [facade, setFacade] = useState<FacadeOption>('on');
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
    mapRef.current?.setBuildingStyle(SAMPLE_BUILDING.id, sampleStyle(true, roof, facade));
    mapRef.current?.setCamera({ center: SAMPLE_BUILDING.coordinate, distance: 220, pitch: 45, bearing: 0, animate: true });
    setCaptured(true);
    setPicked(`picked: ${SAMPLE_BUILDING.id} (captured, ${CAPTURED_COLOR})`);
    pushLog(`setBuildingStyle ${SAMPLE_BUILDING.id}: captured ${CAPTURED_COLOR}`);
  };

  const resetBuilding = () => {
    if (!SAMPLE_BUILDING) return;
    mapRef.current?.setBuildingStyle(SAMPLE_BUILDING.id, null);
    setCaptured(false);
    setRoof('flat');
    setFacade('on');
    setPicked('picked: none');
    pushLog(`setBuildingStyle ${SAMPLE_BUILDING.id}: null`);
  };

  // M2c: roof / facade of the sample building (drawn by the custom building layer).
  const styleSample = (nextRoof: RoofShape, nextFacade: FacadeOption) => {
    setRoof(nextRoof);
    setFacade(nextFacade);
    if (!SAMPLE_BUILDING) return;
    mapRef.current?.setBuildingStyle(SAMPLE_BUILDING.id, sampleStyle(captured, nextRoof, nextFacade));
    pushLog(`setBuildingStyle ${SAMPLE_BUILDING.id}: roof ${nextRoof}, facade ${nextFacade}`);
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          engine="native"
          mapRef={mapRef}
          world={WORLD}
          theme={{ base: preset, timeOfDay }}
          ui={{ zoomButtons: true }}
          camera={{ center: STATION, pitch: 45, distance: 400 }}
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
          <MapOverlay id={STATION_CARD} coordinate={STATION} anchor="bottom" offset={{ x: 0, y: -10 }} pointerEvents="none">
            <View style={styles.card}>
              <Text testID="native-overlay-card" style={styles.cardTitle}>
                {STATION_NAME} Station
              </Text>
              <Text style={styles.cardText}>MapOverlay · native engine</Text>
            </View>
          </MapOverlay>
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
          <Button testID="native-project" title="Round trip the station" onPress={roundTrip} />
        </ButtonRow>
        <Readout testID="native-project-result">{projection}</Readout>
      </Section>
      <Section title="Buildings and presses">
        <ButtonRow>
          <Button
            testID="native-pick-building"
            title={`Pick sample building${SAMPLE_BUILDING ? ` (${SAMPLE_BUILDING.name})` : ''}`}
            disabled={!SAMPLE_BUILDING}
            onPress={pickBuilding}
          />
          <Button testID="native-reset-building" title="Reset style" onPress={resetBuilding} />
          <Button
            testID="native-station-view"
            title="Station view"
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
      <Section title="Roofs and facades (M2c custom layer)">
        <Chips label="Roof" options={ROOF_SHAPES} value={roof} onChange={(v) => styleSample(v, facade)} testIDPrefix="native-roof" />
        <Chips label="Facade" options={FACADE_OPTIONS} value={facade} onChange={(v) => styleSample(roof, v)} testIDPrefix="native-facade" />
        <Readout testID="native-roof-state">{`roof: ${roof} · facade: ${facade}${captured ? ' · captured' : ''}`}</Readout>
        <ButtonRow>
          <Button
            testID="native-closeup"
            title="Close-up"
            disabled={!SAMPLE_BUILDING}
            onPress={() => {
              if (!SAMPLE_BUILDING) return;
              // The sample is a 46 m tower: look down on its roof (gable / dome, captured flag) from above.
              mapRef.current?.setCamera({ center: SAMPLE_BUILDING.coordinate, distance: 280, pitch: 40, bearing: 35, animate: true });
              pushLog('setCamera: sample close-up');
            }}
          />
          <Button
            testID="native-orbit"
            title="Orbit 8 s"
            onPress={() => {
              mapRef.current?.setCamera({ bearing: (camera?.bearing ?? 0) + 180, animate: { durationMs: 8000 } });
              pushLog('setCamera: orbit 180° over 8 s');
            }}
          />
        </ButtonRow>
      </Section>
      <Section title="Theme (setTheme)">
        <Chips label="Preset" options={PRESET_NAMES} value={preset} onChange={setPreset} testIDPrefix="native-theme" />
        <Chips label="Time of day" options={TIMES_OF_DAY} value={timeOfDay} onChange={setTimeOfDay} testIDPrefix="native-time" />
        <Readout testID="native-theme-state">{`theme: ${preset} · ${timeOfDay}`}</Readout>
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
