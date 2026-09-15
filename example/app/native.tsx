// Registers the `native` engine host (C++ core + MapLibre Native) with @maprama/react-native.
import '@maprama/engine-native';
import { useRef, useState } from 'react';
import { haversineMeters, type CameraSpec, type WorldSource } from '@maprama/protocol';
import { useCameraState, type MapramaViewRef } from '@maprama/react-native';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD: WorldSource = { kind: 'data', world: SEONGSU_WORLD };

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
  const mapRef = useRef<MapramaViewRef>(null);
  const camera = useCameraState(mapRef, { throttleMs: 100 });
  const [projection, setProjection] = useState('project: not run yet');
  const [log, pushLog] = useEventLog();

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

  return (
    <ScreenLayout
      map={
        <DemoMap
          engine="native"
          mapRef={mapRef}
          world={WORLD}
          camera={{ center: STATION, pitch: 45, distance: 400 }}
          onReady={(e) => pushLog(`ready: ${e.engine.name} ${e.engine.version} (${e.engine.kind})`)}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        />
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
          {PRESETS.map((preset) => (
            <Button
              key={preset.id}
              testID={`native-preset-${preset.id}`}
              title={preset.title}
              onPress={() => {
                mapRef.current?.setCamera(preset.camera);
                pushLog(`setCamera: ${preset.title}`);
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
      <Section title="Events">
        <EventLog lines={log} testID="native-log" />
      </Section>
    </ScreenLayout>
  );
}
