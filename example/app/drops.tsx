import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Character, DropLayer, type MapramaViewRef, type DropCollectInfo } from '@maprama/react-native';
import type { DropType, LngLat, Rarity } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, EventLog, Readout, ScreenLayout, Section, Toast, Toggle, useEventLog } from '../src/components/ui';
import { API_BASE_URL, API_KEY, DROPS_CHANNEL, probeApi } from '../src/config';
import { SAMPLE_CHARACTER_MODEL_URI } from '../src/data/sampleModel';
import { SEONGSU_WORLD, STATION, haversineMeters, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

interface Item {
  id: string;
  type: DropType;
  rarity: Rarity;
  value: number;
  coordinate: LngLat;
  label: string;
}

const START = offsetMeters(STATION, 0, -90);

const COINS: Item[] = [
  { id: 'coin-1', type: 'coin', rarity: 'common', value: 10, coordinate: offsetMeters(STATION, -30, -60), label: 'coin' },
  { id: 'coin-2', type: 'coin', rarity: 'rare', value: 50, coordinate: offsetMeters(STATION, 30, -60), label: 'gem coin' },
];
const MUSIC: Item[] = [
  { id: 'cd-1', type: 'cd', rarity: 'rare', value: 1, coordinate: offsetMeters(STATION, -40, -20), label: 'CD' },
  { id: 'vinyl-1', type: 'vinyl', rarity: 'legendary', value: 1, coordinate: offsetMeters(STATION, 40, -20), label: 'vinyl' },
  { id: 'note-1', type: 'note', rarity: 'common', value: 1, coordinate: offsetMeters(STATION, 0, 20), label: 'note' },
];
const MODELS: Item[] = [
  { id: 'model-1', type: 'model', rarity: 'legendary', value: 1, coordinate: offsetMeters(STATION, 0, -40), label: 'mystery figure' },
];

const LAYERS = [
  { id: 'coins', items: COINS },
  { id: 'music', items: MUSIC },
  { id: 'models', items: MODELS },
] as const;

export default function DropsScreen() {
  const map = useRef<MapramaViewRef>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ coins: true, music: true, models: true });
  const [collected, setCollected] = useState<string[]>([]);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const [log, pushLog] = useEventLog();
  const [service, setService] = useState(false);
  const [serviceReachable, setServiceReachable] = useState<boolean | null>(null);
  const here = useRef<LngLat>(START);

  useEffect(() => {
    if (!service) return;
    setServiceReachable(null);
    let alive = true;
    probeApi().then((ok) => {
      if (!alive) return;
      setServiceReachable(ok);
      pushLog(ok ? `service reachable at ${API_BASE_URL}` : `service unreachable (${API_KEY ? API_BASE_URL : 'no EXPO_PUBLIC_MAPRAMA_API_KEY'}): skipped`);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  /** Pushes the same external fix a few times: the engine's smoother snaps to a fix after 3 consecutive outliers. */
  const teleport = (to: LngLat) => {
    here.current = to;
    for (let i = 0; i < 4; i++) {
      setTimeout(() => map.current?.pushLocation({ lng: to.lng, lat: to.lat, accuracyMeters: 3, timestamp: Date.now() }), i * 250);
    }
  };

  const onCollect = (e: DropCollectInfo) => {
    const item = LAYERS.flatMap((l) => l.items).find((it) => it.id === e.dropId);
    setCollected((prev) => (prev.includes(e.dropId) ? prev : [...prev, e.dropId]));
    const text = `Collected ${item?.label ?? e.dropId} (${item?.rarity ?? '?'}) from ${e.layerId}`;
    setToast({ text, key: Date.now() });
    pushLog(`${text} · collectId ${e.collectId.slice(0, 8)}…`);
  };

  const remaining = useMemo(
    () => LAYERS.filter((l) => enabled[l.id]).flatMap((l) => l.items).filter((it) => !collected.includes(it.id)),
    [enabled, collected],
  );

  const walkToNextDrop = () => {
    const next = [...remaining].sort((a, b) => haversineMeters(here.current, a.coordinate) - haversineMeters(here.current, b.coordinate))[0];
    if (!next) {
      pushLog('no drops left');
      return;
    }
    pushLog(`walking onto ${next.label}`);
    teleport(next.coordinate);
  };

  return (
    <ScreenLayout
      map={
        <View style={{ flex: 1 }}>
          <DemoMap
            mapRef={map}
            world={WORLD}
            theme={{ base: 'toy', timeOfDay: 'golden' }}
            ui={{ locationPuck: true }}
            location={{ source: 'external' }}
            onReady={() => {
              map.current?.setCamera({ follow: 'me', pitch: 55, distance: 110 });
              teleport(here.current);
            }}
            onError={(e) => pushLog(`error ${e.code}${e.fatal ? ' (fatal)' : ''}: ${e.message}`)}
          >
            {/* Spawn at START so the player does not walk across the drops before the first external fix. */}
            <Character id="me" isPlayer name="Collector" showNameTag color="#22AA66" follow="location" position={START} />
            {LAYERS.filter((l) => enabled[l.id]).map((layer) => (
              <DropLayer
                key={layer.id}
                id={layer.id}
                data={layer.items.filter((it) => !collected.includes(it.id))}
                getId={(it) => it.id}
                getCoordinate={(it) => it.coordinate}
                getType={(it) => it.type}
                getRarity={(it) => it.rarity}
                getValue={(it) => it.value}
                getModel={(it) => (it.type === 'model' ? SAMPLE_CHARACTER_MODEL_URI : undefined)}
                getPayload={(it) => ({ label: it.label })}
                collectRadiusMeters={15}
                onCollect={onCollect}
              />
            ))}
            {service && serviceReachable ? (
              <DropLayer
                id="service"
                source="service"
                channel={DROPS_CHANNEL}
                apiKey={API_KEY}
                baseUrl={API_BASE_URL}
                userId="catalog-demo-user"
                onCollect={onCollect}
                onCollectVerified={(e) => pushLog(`verified ${e.dropId}${e.replayed ? ' (replayed)' : ''}`)}
                onCollectRejected={(e) => pushLog(`rejected ${e.dropId}: ${e.code} (${e.status})`)}
              />
            ) : null}
          </DemoMap>
          <Toast message={toast} testID="drop-toast" />
        </View>
      }
    >
      <Readout testID="collected-count">collected: {collected.length}</Readout>
      <Section title="Player (external location)">
        <ButtonRow>
          <Button title="Walk onto nearest drop" testID="walk-to-drop" onPress={walkToNextDrop} />
          <Button title="Back to start" testID="drops-start" onPress={() => teleport(START)} />
          <Button title="Reset drops" testID="drops-reset" onPress={() => setCollected([])} />
        </ButtonRow>
      </Section>
      <Section title="Layers">
        {LAYERS.map((l) => (
          <Toggle
            key={l.id}
            label={`${l.id} (${l.items.map((it) => `${it.type}/${it.rarity}`).join(', ')})`}
            value={!!enabled[l.id]}
            onChange={(v) => setEnabled((prev) => ({ ...prev, [l.id]: v }))}
            testID={`layer-${l.id}`}
          />
        ))}
        <Toggle label={`service drops (${DROPS_CHANNEL} @ ${API_BASE_URL})`} value={service} onChange={setService} testID="layer-service" />
        {service ? (
          <Readout testID="service-state">
            service: {serviceReachable === null ? 'probing…' : serviceReachable ? 'reachable' : 'unreachable, skipped'}
          </Readout>
        ) : null}
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="drops-log" />
      </Section>
    </ScreenLayout>
  );
}
