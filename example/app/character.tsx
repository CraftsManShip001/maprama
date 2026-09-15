import { useRef, useState } from 'react';
import { Character, useCharacterPosition, type DioramaMapRef } from '@diorama/react-native';
import type { LngLat, LocationSourceKind } from '@diorama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SAMPLE_CHARACTER_MODEL_URI } from '../src/data/sampleModel';
import { SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;
const MODELS = ['sample', 'default'] as const;
type ModelChoice = (typeof MODELS)[number];
const SOURCES: readonly LocationSourceKind[] = ['simulated', 'device', 'external'];
const STEP_METERS = 10;

export default function CharacterScreen() {
  const map = useRef<DioramaMapRef>(null);
  const [model, setModel] = useState<ModelChoice>('sample');
  const [source, setSource] = useState<LocationSourceKind>('simulated');
  const [log, pushLog] = useEventLog();
  const position = useCharacterPosition(map, 'me', { throttleMs: 500 });
  const joystick = useRef<LngLat | null>(null);

  const push = (target: LngLat) => {
    joystick.current = target;
    map.current?.pushLocation({ lng: target.lng, lat: target.lat, accuracyMeters: 5, timestamp: Date.now() });
    pushLog(`pushLocation ${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}`);
  };
  const move = (east: number, north: number) => {
    const from = joystick.current ?? position?.coordinate ?? STATION;
    push(offsetMeters(from, east, north));
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'toy', timeOfDay: 'day' }}
          ui={{ locationPuck: true }}
          location={{ source }}
          onReady={() => map.current?.setCamera({ follow: 'me', pitch: 50, distance: 70 })}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <Character
            id="me"
            isPlayer
            name="You"
            showNameTag
            color="#2F5BEA"
            follow="location"
            model={model === 'sample' ? SAMPLE_CHARACTER_MODEL_URI : undefined}
            animations={{ idle: 'idle', walk: 'walk' }}
          />
        </DemoMap>
      }
    >
      <Readout testID="player-position">
        {position
          ? `me: ${position.coordinate.lat.toFixed(5)}, ${position.coordinate.lng.toFixed(5)} · ${position.speedMps.toFixed(1)} m/s · ${Math.round(position.headingDeg)}°`
          : 'me: waiting for position'}
      </Readout>
      <Section title="Model">
        <Chips
          options={MODELS}
          value={model}
          onChange={setModel}
          testIDPrefix="character-model"
          labels={{ sample: 'sample glTF (CC0, data: URI)', default: 'engine default avatar' }}
        />
      </Section>
      <Section title="Location source">
        <Chips
          options={SOURCES}
          value={source}
          onChange={(next) => {
            setSource(next);
            if (next === 'external') push(position?.coordinate ?? STATION);
          }}
          testIDPrefix="location-source"
        />
      </Section>
      {source === 'external' ? (
        <Section title={`External fixes (${STEP_METERS} m steps)`}>
          <ButtonRow>
            <Button title="North" testID="joy-north" onPress={() => move(0, STEP_METERS)} />
            <Button title="South" testID="joy-south" onPress={() => move(0, -STEP_METERS)} />
            <Button title="West" testID="joy-west" onPress={() => move(-STEP_METERS, 0)} />
            <Button title="East" testID="joy-east" onPress={() => move(STEP_METERS, 0)} />
            <Button title="Station" testID="joy-station" onPress={() => push(STATION)} />
          </ButtonRow>
        </Section>
      ) : null}
      <Section title="Events">
        <EventLog lines={log} testID="character-log" />
      </Section>
    </ScreenLayout>
  );
}
