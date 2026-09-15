import { useEffect, useRef, useState } from 'react';
import { Character, type DioramaMapRef } from '@diorama/react-native';
import type { LngLat, TravelMode } from '@diorama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

const MODE_CHAINS = {
  walk: ['walk'],
  bike: ['bike'],
  car: ['car'],
  mixed: ['walk', 'car', 'walk'],
  plane: ['plane'],
  subway: ['subway'],
} satisfies Record<string, TravelMode[]>;
type ModeChoice = keyof typeof MODE_CHAINS;
const MODES = Object.keys(MODE_CHAINS) as ModeChoice[];

// Presets sit on short, direct road paths from START (Seongsu sample road graph):
// NEAR is ≈74 m along the roads, FAR ≈347 m.
const START = offsetMeters(STATION, -40, -30);
const NEAR = offsetMeters(STATION, -70, -90);
const FAR = offsetMeters(STATION, 10, -370);

export default function TravelScreen() {
  const map = useRef<DioramaMapRef>(null);
  const [mode, setMode] = useState<ModeChoice>('walk');
  const [status, setStatus] = useState('idle');
  const [eta, setEta] = useState('ETA —');
  const [log, pushLog] = useEventLog();

  useEffect(() => {
    const api = map.current;
    if (!api) return undefined;
    return api.subscribe(
      'travel:progress',
      (e) => setEta(`ETA ${Math.round(e.etaSeconds)} s · ${Math.round(e.remainingMeters)} m left · ${e.mode}`),
      { id: 'me', throttleMs: 250 },
    );
  }, []);

  const go = (to: LngLat, label: string) => {
    const api = map.current;
    if (!api) return;
    const modes = MODE_CHAINS[mode];
    setStatus(`travelling (${mode})`);
    pushLog(`travel to ${label} via ${modes.join(' → ')}`);
    api
      .travel('me', to, modes, { timeoutMs: 10 * 60_000 })
      .then((result) => {
        setStatus('arrived');
        setEta('ETA 0 s');
        pushLog(`arrived: ${result.legs.map((l) => `${l.mode} ${Math.round(l.meters)} m`).join(', ')}`);
      })
      .catch((e: { code?: string; message?: string }) => {
        setStatus(`failed: ${e.code ?? 'error'}`);
        pushLog(`travel failed: ${e.code ?? ''} ${e.message ?? ''}`);
      });
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'modern', timeOfDay: 'day' }}
          location={{ source: 'external' }}
          onReady={() => map.current?.setCamera({ follow: 'me', pitch: 50, distance: 160 })}
          onPress={(e) => go(e.coordinate, `tap ${e.coordinate.lat.toFixed(5)}, ${e.coordinate.lng.toFixed(5)}`)}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <Character id="me" isPlayer name="Traveller" showNameTag color="#E0457B" follow="none" position={START} />
        </DemoMap>
      }
    >
      <Readout testID="travel-status">status: {status}</Readout>
      <Readout testID="travel-eta">{eta}</Readout>
      <Section title="Mode (tap the map to travel there)">
        <Chips options={MODES} value={mode} onChange={setMode} testIDPrefix="mode" labels={{ mixed: 'mixed (walk → car → walk)' }} />
      </Section>
      <Section title="Preset destinations">
        <ButtonRow>
          <Button title="Near (≈75 m)" testID="travel-go-near" onPress={() => go(NEAR, 'near')} />
          <Button title="Far (≈350 m)" testID="travel-go-far" onPress={() => go(FAR, 'far')} />
          <Button title="Cancel" testID="travel-cancel" onPress={() => map.current?.cancelTravel('me')} />
        </ButtonRow>
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="travel-log" />
      </Section>
    </ScreenLayout>
  );
}
