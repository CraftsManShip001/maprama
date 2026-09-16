// Registers the `native` engine host (C++ core + MapLibre Native) with @maprama/react-native.
import '@maprama/engine-native';
import { useEffect, useRef, useState } from 'react';
import { Character, DropLayer, Geofence, useCharacterPosition, type DropCollectInfo, type MapramaViewRef } from '@maprama/react-native';
import { haversineMeters, type DropType, type LngLat, type Rarity } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, EventLog, Readout, ScreenLayout, Section, useEventLog } from '../src/components/ui';
import { SAMPLE_CHARACTER_MODEL_URI } from '../src/data/sampleModel';
import { SEONGSU_WORLD, STATION, lerpLngLat, offsetMeters, worldToLngLat } from '../src/data/seongsu';

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
const SHOWCASE_LAYER = 'm3b-showcase';

interface Drop {
  id: string;
  rarity: Rarity;
  coordinate: LngLat;
}

interface ShowcaseDrop extends Drop {
  type: DropType;
  value?: number;
}

/** M3b: one of each 3D drop item (engine-web's shapes) in a row on open ground south of START (world z 7.05, clear
 *  of every footprint), seen from the south-east so no building is in front of them; nobody collects them. */
const SHOWCASE: ShowcaseDrop[] = [
  { id: 'show-coin', type: 'coin', rarity: 'common', value: 10, coordinate: worldToLngLat(-8.9, 7.05) },
  { id: 'show-gem', type: 'coin', rarity: 'rare', value: 80, coordinate: worldToLngLat(-7.9, 7.05) },
  { id: 'show-cd', type: 'cd', rarity: 'rare', coordinate: worldToLngLat(-6.9, 7.05) },
  { id: 'show-vinyl', type: 'vinyl', rarity: 'legendary', coordinate: worldToLngLat(-5.9, 7.05) },
  { id: 'show-note', type: 'note', rarity: 'common', coordinate: worldToLngLat(-4.9, 7.05) },
  { id: 'show-model', type: 'model', rarity: 'rare', coordinate: worldToLngLat(-3.9, 7.05) },
];
const SHOWCASE_CAMERA = { center: worldToLngLat(-6.4, 7.05), distance: 115, pitch: 55, bearing: 315 };

// M3b occlusion close-up: three statues (×1.4) on open ground just south of the 3.75-unit block w574635637 (world
// x −23.7…−20.6, z −11.9…−9.1), seen from the north. Chosen with a ray cast over the sample's footprints: one is
// hidden by the buildings, one shows only its upper half above the block, one stands in the open.
const STATUES = [
  { id: 'statue-hidden', model: true, at: worldToLngLat(-19.5, -7.0) },
  { id: 'statue-half', model: false, at: worldToLngLat(-23.5, -7.0) },
  { id: 'statue-open', model: true, at: worldToLngLat(-25.5, -7.0) },
];
const OCCLUSION_CAMERA = { center: worldToLngLat(-22.5, -7.5), distance: 120, pitch: 45, bearing: 170 };

/** Crowd sizes for the per-frame cost measurements (total characters on screen). */
type Crowd = 0 | 1 | 10 | 50;

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

/** Deterministic pseudo-random point within `radius` meters of `center` (crowd walks). */
function scatter(center: LngLat, seed: number, radius: number): LngLat {
  const a = Math.sin(seed * 12.9898) * 43758.5453;
  const b = Math.sin(seed * 78.233) * 12543.123;
  const u = a - Math.floor(a), v = b - Math.floor(b);
  return offsetMeters(center, (u * 2 - 1) * radius, (v * 2 - 1) * radius);
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
  const [occlusion, setOcclusion] = useState(false);
  const [crowd, setCrowd] = useState<Crowd>(0);
  const [log, pushLog] = useEventLog();
  // requestId of the travel shown in the ETA line (progress of a cancelled / finished travel is ignored).
  const activeTravel = useRef<string | null>(null);
  const tripSeq = useRef(0);
  const crowdGeneration = useRef(0);

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
        if (!e.characterId.startsWith('crowd-')) pushLog(`travel:cancel (${e.characterId})`);
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

  const follow = (id: string, distance = 200, pitch = 50) => {
    mapRef.current?.setCamera({ follow: id, pitch, distance });
    pushLog(`setCamera follow ${id}`);
  };

  const showOcclusion = () => {
    setOcclusion(true);
    mapRef.current?.setCamera({ follow: null, ...OCCLUSION_CAMERA, animate: true });
  };

  // Crowd members walk between scattered points around START (walk ×20), re-travelling on every arrival.
  const crowdIds = crowd > 2 ? Array.from({ length: crowd - 2 }, (_, i) => `crowd-${i}`) : [];
  useEffect(() => {
    const generation = ++crowdGeneration.current;
    const api = mapRef.current;
    if (!api || crowdIds.length === 0) return undefined;
    let hop = 0;
    const walk = (id: string, seed: number) => {
      if (generation !== crowdGeneration.current) return;
      api
        .travel(id, scatter(START, seed + hop++ * 97, 110), ['walk'], { timeoutMs: 10 * 60_000 })
        .then(() => walk(id, seed + 1))
        .catch(() => undefined);
    };
    // The characters are created by the render below; start walking on the next tick.
    const timer = setTimeout(() => crowdIds.forEach((id, i) => walk(id, i * 13 + 1)), 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crowd]);

  const setCrowdSize = (size: Crowd) => {
    setCrowd(size);
    pushLog(size ? `crowd: ${size} characters` : 'crowd off');
    // The crowd walks within ≈110 m of START: frame it (the single-character run keeps the camera).
    if (size > 1) mapRef.current?.setCamera({ follow: null, center: START, distance: 320, pitch: 45, animate: true });
  };

  const characters = crowd === 1 ? 1 : 2 + crowdIds.length + (occlusion ? STATUES.length : 0);

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
          {crowd !== 1 && <Character id="me" isPlayer name="Traveller" showNameTag color="#E0457B" follow="none" position={START} />}
          {/* M3b: the example glTF robot (idle / walk clips) walks the simulated loop; "me" is the procedural body.
              Both show their name tags (M2b label views, engine-web anchors: above the head, on the vehicle). */}
          <Character id="walker" name="Walker" showNameTag color="#D3A03E" follow="location" model={SAMPLE_CHARACTER_MODEL_URI} />
          {occlusion &&
            STATUES.map((s) => (
              <Character
                key={s.id}
                id={s.id}
                color="#3F86BE"
                follow="none"
                scale={1.4}
                position={s.at}
                model={s.model ? SAMPLE_CHARACTER_MODEL_URI : undefined}
              />
            ))}
          {crowdIds.map((id, i) => (
            <Character
              key={id}
              id={id}
              follow="none"
              position={scatter(START, i * 13 + 1, 90)}
              model={i % 2 === 0 ? SAMPLE_CHARACTER_MODEL_URI : undefined}
            />
          ))}
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
          <DropLayer
            id={SHOWCASE_LAYER}
            data={SHOWCASE}
            getId={(d) => d.id}
            getCoordinate={(d) => d.coordinate}
            getType={(d) => d.type}
            getRarity={(d) => d.rarity}
            getValue={(d) => d.value}
            getModel={(d) => (d.type === 'model' ? SAMPLE_CHARACTER_MODEL_URI : undefined)}
            collectorIds={[]}
            collectRadiusMeters={1}
          />
          <Geofence
            id={ZONE}
            center={NEAR}
            radiusMeters={ZONE_RADIUS}
            onEnter={(e) => {
              if (!e.characterId.startsWith('crowd-')) pushLog(`enter ${e.geofenceId} (${e.characterId})`);
              if (e.characterId === 'me') setZone((z) => ({ ...z, inside: true, enters: z.enters + 1 }));
            }}
            onExit={(e) => {
              if (!e.characterId.startsWith('crowd-')) pushLog(`exit ${e.geofenceId} (${e.characterId})`);
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
      <Section title="3D models (M3b)">
        <ButtonRow>
          <Button title="Occlusion close-up" testID="native-game-occlusion" onPress={showOcclusion} />
          <Button title="Close-up walker" testID="native-game-closeup-walker" onPress={() => follow('walker', 115, 55)} />
          <Button title="Showcase drops" testID="native-game-showcase" onPress={() => mapRef.current?.setCamera({ follow: null, ...SHOWCASE_CAMERA, animate: true })} />
        </ButtonRow>
        <ButtonRow>
          <Button title="1" testID="native-game-crowd-1" onPress={() => setCrowdSize(1)} />
          <Button title="10" testID="native-game-crowd-10" onPress={() => setCrowdSize(10)} />
          <Button title="50" testID="native-game-crowd-50" onPress={() => setCrowdSize(50)} />
          <Button title="Crowd off" testID="native-game-crowd-off" onPress={() => setCrowdSize(0)} />
        </ButtonRow>
        <Readout testID="native-game-models">{`models: ${characters} characters · crowd: ${crowd} · occlusion: ${occlusion ? 'on' : 'off'}`}</Readout>
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="native-game-log" />
      </Section>
    </ScreenLayout>
  );
}
