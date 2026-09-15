import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CharacterLayer, MapOverlay } from '@diorama/react-native';
import type { LngLat } from '@diorama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Readout, ScreenLayout, Section, Toggle } from '../src/components/ui';
import { SAMPLE_CHARACTER_MODEL_URI } from '../src/data/sampleModel';
import { SEONGSU_WORLD, STATION, STATION_NAME, haversineMeters, lerpLngLat, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;
const TICK_MS = 1000;
const FRAME_MS = 100;
const ROAM_RADIUS = 150;
const NAMES = ['Mina', 'Joon', 'Ari', 'Sol', 'Dae', 'Yuna'];
const COLORS = ['#E0457B', '#2F5BEA', '#22AA66', '#FF8800', '#8B5CF6', '#0EA5E9'];

interface Remote {
  id: string;
  name: string;
  color: string;
  useModel: boolean;
  from: LngLat;
  to: LngLat;
}

interface Player {
  id: string;
  name: string;
  color: string;
  useModel: boolean;
  coordinate: LngLat;
}

/** One simulated "server" step: a random walk of up to ~12 m, pulled back towards the station. */
function step(p: LngLat): LngLat {
  const next = offsetMeters(p, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24);
  if (haversineMeters(STATION, next) <= ROAM_RADIUS) return next;
  return lerpLngLat(p, STATION, 0.1);
}

function initialRemotes(): Remote[] {
  return NAMES.map((name, i) => {
    const angle = (i / NAMES.length) * Math.PI * 2;
    const start = offsetMeters(STATION, Math.cos(angle) * 60, Math.sin(angle) * 60);
    return { id: `remote-${i}`, name, color: COLORS[i]!, useModel: i % 2 === 0, from: start, to: start };
  });
}

export default function MultiplayerScreen() {
  const remotes = useRef<Remote[]>(initialRemotes());
  const tickAt = useRef(Date.now());
  const [tick, setTick] = useState(0);
  const [interpolate, setInterpolate] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [players, setPlayers] = useState<Player[]>(() => remotes.current.map((r) => ({ ...r, coordinate: r.to })));

  useEffect(() => {
    const render = () => {
      const k = interpolate ? Math.min(1, (Date.now() - tickAt.current) / TICK_MS) : 1;
      setPlayers(remotes.current.map((r) => ({ id: r.id, name: r.name, color: r.color, useModel: r.useModel, coordinate: lerpLngLat(r.from, r.to, k) })));
    };
    // Simulated server: new authoritative positions once per second.
    const server = setInterval(() => {
      remotes.current = remotes.current.map((r) => ({ ...r, from: r.to, to: step(r.to) }));
      tickAt.current = Date.now();
      setTick((t) => t + 1);
      if (!interpolate) render();
    }, TICK_MS);
    // Client: interpolate between the last two server positions at 10 Hz.
    const frame = interpolate ? setInterval(render, FRAME_MS) : null;
    return () => {
      clearInterval(server);
      if (frame) clearInterval(frame);
    };
  }, [interpolate]);

  const nearby = players.filter((p) => haversineMeters(STATION, p.coordinate) <= 100).length;
  const lead = players[0];

  return (
    <ScreenLayout
      map={
        <DemoMap world={WORLD} theme={{ base: 'soft', timeOfDay: 'day' }} camera={{ center: STATION, pitch: 50, distance: 300 }}>
          <CharacterLayer
            data={players}
            getId={(p) => p.id}
            getPosition={(p) => p.coordinate}
            getName={(p) => p.name}
            getColor={(p) => p.color}
            getModel={(p) => (p.useModel ? SAMPLE_CHARACTER_MODEL_URI : undefined)}
            getAnimations={(p) => (p.useModel ? { idle: 'idle', walk: 'walk' } : undefined)}
            showNameTags={showNames}
          />
          <MapOverlay id="station-card" coordinate={STATION} anchor="bottom" offset={{ x: 0, y: -6 }}>
            <View testID="poi-card" style={styles.card}>
              <Text style={styles.cardTitle}>{STATION_NAME} Station</Text>
              <Text style={styles.cardBody}>{nearby} players within 100 m</Text>
            </View>
          </MapOverlay>
          {lead ? (
            <MapOverlay id="lead-bubble" coordinate={lead.coordinate} anchor="bottom" offset={{ x: 0, y: -40 }}>
              <View testID="lead-bubble" style={styles.bubble}>
                <Text style={styles.bubbleText}>{lead.name}: hi!</Text>
              </View>
            </MapOverlay>
          ) : null}
        </DemoMap>
      }
    >
      <Readout testID="mp-tick">server tick: {tick} · {players.length} remote players</Readout>
      <Section title="Remote players">
        <Toggle label="Interpolate (10 Hz)" value={interpolate} onChange={setInterpolate} testID="mp-interpolate" />
        <Toggle label="Name tags" value={showNames} onChange={setShowNames} testID="mp-names" />
      </Section>
    </ScreenLayout>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: 'white', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  cardTitle: { fontWeight: '700', color: '#0f172a' },
  cardBody: { color: '#475569', fontSize: 12 },
  bubble: { backgroundColor: '#0f172a', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  bubbleText: { color: 'white', fontSize: 11 },
});
