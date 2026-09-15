// Registers the `native` engine host (C++ core + MapLibre Native) with @maprama/react-native.
import '@maprama/engine-native';
import { useEffect, useRef, useState } from 'react';
import { Character, DropLayer, Geofence, useCharacterPosition, type DropCollectInfo, type MapramaViewRef } from '@maprama/react-native';
import { haversineMeters, type LngLat, type Rarity } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION, lerpLngLat, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

// Same presets and playback speed as the Travel screen (travel.tsx): NEAR is ≈74 m along the roads from
// START, FAR ≈347 m; ×20 keeps the trips at ≈3 s and ≈13 s of walking.
const DEMO_TIME_SCALE = 20;
const START = offsetMeters(STATION, -40, -30);
const NEAR = offsetMeters(STATION, -70, -90);
const FAR = offsetMeters(STATION, 10, -370);
const ZONE = 'near-zone';
const ZONE_RADIUS = 25;
const DROP_LAYER = 'm3a-drops';

interface Drop {
  id: string;
  rarity: Rarity;
  coordinate: LngLat;
}

/** The point halfway along a route path (by ground distance). */
function halfway(path: LngLat[]): LngLat | null {
  if (path.length < 2) return path[0] ?? null;
  const lengths = path.slice(1).map((p, i) => haversineMeters(path[i]!, p));
  let rest = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (rest <= lengths[i]!) return lerpLngLat(path[i]!, path[i + 1]!, lengths[i]! > 0 ? rest / lengths[i]! : 0);
    rest -= lengths[i]!;
  }
  return path[path.length - 1]!;
}

const fixed = (value: number, digits: number) => value.toFixed(digits);

export default function NativeGameScreen() {
  const mapRef = useRef<MapramaViewRef>(null);
  const walker = useCharacterPosition(mapRef, 'walker', { throttleMs: 250 });
  const [status, setStatus] = useState('idle');
  const [eta, setEta] = useState('ETA —');
  const [route, setRoute] = useState('route: waiting for the route request');
  const [drops, setDrops] = useState<Drop[]>([]);
  const [collected, setCollected] = useState<string[]>([]);
  const [zone, setZone] = useState({ inside: false, enters: 0, exits: 0 });
  const [log, pushLog] = useEventLog();
  // requestId of the travel shown in the ETA line (progress of a cancelled / finished travel is ignored).
  const activeTravel = useRef<string | null>(null);
  const tripSeq = useRef(0);

  useEffect(() => {
    const api = mapRef.current;
    if (!api) return undefined;
    const offs = [
      api.addEventListener('travel:start', (e) => {
        if (e.characterId !== 'me') return;
        activeTravel.current = e.requestId;
        pushLog(`travel:start ${e.legs.map((l) => `${l.mode} ${Math.round(l.meters)} m`).join(', ')}`);
      }),
      api.addEventListener('travel:arrive', (e) => {
        if (e.requestId === activeTravel.current) activeTravel.current = null;
      }),
      api.addEventListener('travel:cancel', (e) => {
        if (e.requestId === activeTravel.current) activeTravel.current = null;
        pushLog(`travel:cancel (${e.characterId})`);
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
    // Subscribed once (pushLog only appends through a state updater).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Plans START → NEAR → FAR with the `route` request and drops one collectible halfway along each leg. */
  const planDrops = async () => {
    const api = mapRef.current;
    if (!api) return;
    try {
      const [first, second] = await Promise.all([api.route(START, NEAR, ['walk']), api.route(NEAR, FAR, ['walk'])]);
      setRoute(
        `route: ${Math.round(first.meters)} m · ETA ${Math.round(first.etaSeconds)} s real-world (then ${Math.round(second.meters)} m to far)`,
      );
      const next: Drop[] = [];
      const a = halfway(first.legs.flatMap((l) => l.path));
      const b = halfway(second.legs.flatMap((l) => l.path));
      if (a) next.push({ id: 'coin-near', rarity: 'rare', coordinate: a });
      if (b) next.push({ id: 'coin-far', rarity: 'legendary', coordinate: b });
      setDrops(next);
      pushLog(`route ${Math.round(first.meters)} m: ${next.length} drops placed on the way`);
    } catch (e) {
      setRoute(`route failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const go = (to: LngLat, label: string) => {
    const api = mapRef.current;
    if (!api) return;
    const seq = ++tripSeq.current;
    setStatus(`travelling to ${label}`);
    setEta('ETA —');
    api
      .travel('me', to, ['walk'], { timeoutMs: 10 * 60_000 })
      .then(() => {
        pushLog(`travel:arrive at ${label}`);
        if (seq !== tripSeq.current) return;
        setStatus(`arrived at ${label}`);
        setEta('ETA 0 s');
      })
      .catch((e: { code?: string; message?: string }) => {
        pushLog(`travel failed: ${e.code ?? ''} ${e.message ?? ''}`);
        if (seq === tripSeq.current) setStatus(`failed: ${e.code ?? 'error'}`);
      });
  };

  const onCollect = (e: DropCollectInfo) => {
    setCollected((prev) => (prev.includes(e.dropId) ? prev : [...prev, e.dropId]));
    pushLog(`collected ${e.dropId} from ${e.layerId} (${e.characterId}) · ${e.collectId.slice(0, 8)}…`);
  };

  const follow = (id: string) => {
    mapRef.current?.setCamera({ follow: id, pitch: 50, distance: 200 });
    pushLog(`setCamera follow ${id}`);
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          engine="native"
          mapRef={mapRef}
          world={WORLD}
          theme={{ base: 'modern', timeOfDay: 'day' }}
          ui={{ locationPuck: true }}
          location={{ source: 'simulated' }}
          travelTimeScale={DEMO_TIME_SCALE}
          camera={{ center: START, pitch: 50, distance: 260 }}
          onReady={(e) => {
            pushLog(`ready: ${e.engine.name} (${e.engine.kind})`);
            void planDrops();
          }}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <Character id="me" isPlayer name="Traveller" color="#E0457B" follow="none" position={START} />
          <Character id="walker" name="Walker" color="#D3A03E" follow="location" />
          <DropLayer
            id={DROP_LAYER}
            data={drops.filter((d) => !collected.includes(d.id))}
            getId={(d) => d.id}
            getCoordinate={(d) => d.coordinate}
            getType={() => 'coin'}
            getRarity={(d) => d.rarity}
            getValue={() => 10}
            collectRadiusMeters={12}
            onCollect={onCollect}
          />
          <Geofence
            id={ZONE}
            center={NEAR}
            radiusMeters={ZONE_RADIUS}
            onEnter={(e) => {
              pushLog(`enter ${e.geofenceId} (${e.characterId})`);
              if (e.characterId === 'me') setZone((z) => ({ ...z, inside: true, enters: z.enters + 1 }));
            }}
            onExit={(e) => {
              pushLog(`exit ${e.geofenceId} (${e.characterId})`);
              if (e.characterId === 'me') setZone((z) => ({ ...z, inside: false, exits: z.exits + 1 }));
            }}
          />
        </DemoMap>
      }
    >
      <Readout testID="native-game-status">status: {status}</Readout>
      <Readout testID="native-game-eta">{eta}</Readout>
      <Readout testID="native-game-collected">{`collected: ${collected.length}${collected.length ? ` (${collected.join(', ')})` : ''}`}</Readout>
      <Readout testID="native-game-zone">{`${ZONE}: ${zone.inside ? 'inside' : 'outside'} (enter ${zone.enters}, exit ${zone.exits})`}</Readout>
      <Readout testID="native-game-walker">
        {walker
          ? `walker: ${fixed(walker.coordinate.lng, 5)}, ${fixed(walker.coordinate.lat, 5)} · ${fixed(walker.headingDeg, 0)}° · ${fixed(
              walker.speedMps,
              1,
            )} m/s`
          : 'walker: waiting for character:position'}
      </Readout>
      <Readout testID="native-game-route">{route}</Readout>
      <Section title={`Travel (walk ×${DEMO_TIME_SCALE})`}>
        <ButtonRow>
          <Button title="Near (≈75 m)" testID="native-game-go-near" onPress={() => go(NEAR, 'near')} />
          <Button title="Far (≈350 m)" testID="native-game-go-far" onPress={() => go(FAR, 'far')} />
          <Button title="Cancel" testID="native-game-cancel" onPress={() => mapRef.current?.cancelTravel('me')} />
        </ButtonRow>
        <ButtonRow>
          <Button title="Follow me" testID="native-game-follow-me" onPress={() => follow('me')} />
          <Button title="Follow walker" testID="native-game-follow-walker" onPress={() => follow('walker')} />
          <Button
            title="Overview"
            testID="native-game-overview"
            onPress={() => mapRef.current?.setCamera({ follow: null, center: offsetMeters(STATION, -20, -160), distance: 700, pitch: 40, animate: true })}
          />
        </ButtonRow>
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="native-game-log" />
      </Section>
    </ScreenLayout>
  );
}
