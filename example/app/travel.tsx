import { useEffect, useRef, useState } from 'react';
import { Character, type MapramaViewRef } from '@maprama/react-native';
import type { LngLat, TravelMode } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

// Travel runs at real-world speed by default (walk 4.8 km/h: the far preset would take ≈4 min).
// The demo fast-forwards 20× so trips stay short on screen and the Maestro flow keeps its timing
// (.maestro/02-travel-arrive.yaml: far ≈347 m ≈ 13 s, near ≈74 m ≈ 3 s of walking).
const DEMO_TIME_SCALE = 20;

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
  const map = useRef<MapramaViewRef>(null);
  const [mode, setMode] = useState<ModeChoice>('walk');
  const [status, setStatus] = useState('idle');
  const [eta, setEta] = useState('ETA —');
  const [log, pushLog] = useEventLog();
  // requestId of the travel shown in the ETA line. Progress of any other travel is ignored, e.g. a
  // throttled travel:progress delivered after travel:arrive or after the travel was cancelled.
  const activeTravel = useRef<string | null>(null);
  // Bumped on every travel so a superseded travel's promise does not overwrite the newer status.
  const tripSeq = useRef(0);

  useEffect(() => {
    const api = map.current;
    if (!api) return undefined;
    const offs = [
      api.addEventListener('travel:start', (e) => {
        if (e.characterId === 'me') activeTravel.current = e.requestId;
      }),
      api.addEventListener('travel:arrive', (e) => {
        if (e.requestId === activeTravel.current) activeTravel.current = null;
      }),
      api.addEventListener('travel:cancel', (e) => {
        if (e.requestId === activeTravel.current) activeTravel.current = null;
      }),
      api.subscribe(
        'travel:progress',
        (e) => {
          if (e.requestId !== activeTravel.current) return;
          setEta(`ETA ${Math.round(e.etaSeconds)} s · ${Math.round(e.remainingMeters)} m left · ${e.mode}`);
        },
        { id: 'me', throttleMs: 250 },
      ),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const go = (to: LngLat, label: string) => {
    const api = map.current;
    if (!api) return;
    const modes = MODE_CHAINS[mode];
    const seq = ++tripSeq.current;
    setStatus(`travelling (${mode})`);
    setEta('ETA —');
    pushLog(`travel to ${label} via ${modes.join(' → ')} at ×${DEMO_TIME_SCALE}`);
    api
      .travel('me', to, modes, { timeoutMs: 10 * 60_000 })
      .then((result) => {
        pushLog(`arrived: ${result.legs.map((l) => `${l.mode} ${Math.round(l.meters)} m`).join(', ')}`);
        if (seq !== tripSeq.current) return;
        setStatus('arrived');
        setEta('ETA 0 s');
      })
      .catch((e: { code?: string; message?: string }) => {
        pushLog(`travel failed: ${e.code ?? ''} ${e.message ?? ''}`);
        if (seq !== tripSeq.current) return;
        setStatus(`failed: ${e.code ?? 'error'}`);
        setEta('ETA —');
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
          travelTimeScale={DEMO_TIME_SCALE}
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
      <Readout testID="travel-playback">playback ×{DEMO_TIME_SCALE} (×1 = real-world speed)</Readout>
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
