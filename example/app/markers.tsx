import { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MarkerLayer, type MapramaViewRef, type MarkerPressInfo } from '@maprama/react-native';
import type { LngLat } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, Toggle, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION, STATION_NAME, worldToLngLat } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

/** Two "faction" palettes; the second one simulates the server's 45 s colour refresh. */
const PALETTES = [
  { blue: '#2F5BEA', red: '#E0452F' },
  { blue: '#0F9D8C', red: '#B8347A' },
] as const;

const STAR_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDIuNmwyLjcgNS42IDYuMS45LTQuNCA0LjMgMSA2LjEtNS40LTIuOS01LjQgMi45IDEtNi4xTDMuMiA5LjFsNi4xLS45eiIgZmlsbD0iIzFFMjUzMyIvPjwvc3ZnPg==';
const CAMERA_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTQgOGg0bDEuNi0yaDQuOEwxNiA4aDR2MTFINHoiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFFMjUzMyIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMy40IiByPSIzLjIiIGZpbGw9IiMxRTI1MzMiLz48L3N2Zz4=';

interface Poi {
  id: string;
  title: string;
  faction: 'blue' | 'red';
  coordinate: LngLat;
  /** Partner spots are never hidden by collision. */
  partner: boolean;
  priority: number;
}

/** The pin the flow taps: exactly on the camera target, so it sits in the middle of the map. */
const HERO: Poi = {
  id: 'hero',
  title: STATION_NAME,
  faction: 'blue',
  coordinate: STATION,
  partner: true,
  priority: 100,
};

/** Enough anchors for 60 pins: the sample's POIs, topped up with building centroids. */
const ANCHORS: { id: string; title: string; coordinate: LngLat }[] = [
  ...SEONGSU_WORLD.pois.map((p, i) => ({ id: p.id, title: p.name || `POI ${i + 1}`, coordinate: worldToLngLat(p.x, p.z) })),
  ...SEONGSU_WORLD.buildings.slice(0, 8).map((b, i) => {
    const n = b.footprint.length;
    const cx = b.footprint.reduce((a, q) => a + q[0], 0) / n;
    const cz = b.footprint.reduce((a, q) => a + q[1], 0) / n;
    return { id: `b-${b.id}`, title: b.name || `Spot ${i + 1}`, coordinate: worldToLngLat(cx, cz) };
  }),
];

/** Server-provided POIs in two faction colours, a few of them partners. */
const POOL: Poi[] = [
  HERO,
  ...ANCHORS.map((a, i): Poi => ({
    id: a.id,
    title: a.title,
    faction: i % 2 === 0 ? 'blue' : 'red',
    coordinate: a.coordinate,
    partner: i % 9 === 0,
    priority: 60 - i,
  })),
];

/** Pin counts the screen can show; 0 and 60 are the before / after of the performance run. */
const COUNTS = ['0', '40', '60'] as const;
type Count = (typeof COUNTS)[number];

export default function MarkersScreen() {
  const map = useRef<MapramaViewRef>(null);
  const [count, setCount] = useState<Count>('40');
  const [selectedId, setSelectedId] = useState<string | null>(HERO.id);
  const [tick, setTick] = useState(0);
  const [partners, setPartners] = useState(true);
  const [press, setPress] = useState<MarkerPressInfo | null>(null);
  const [log, pushLog] = useEventLog();

  const palette = PALETTES[tick % PALETTES.length]!;
  // The hero pin stays first, so "0 pins" really means an empty layer.
  const pois = useMemo(() => POOL.slice(0, Number(count)), [count]);

  /** The 45 s server tick: only colours and the selected id change, the marker list does not. */
  const refresh = () => {
    const next = tick + 1;
    setTick(next);
    const pick = pois[next % Math.max(1, pois.length)] ?? HERO;
    setSelectedId(pick.id);
    pushLog(`server tick ${next}: colours + selected → ${pick.id} (no marker rebuild)`);
  };

  const onMarkerPress = (e: MarkerPressInfo) => {
    setSelectedId(e.markerId);
    setPress(e);
    pushLog(`marker:press ${e.markerId} at ${Math.round(e.point.x)},${Math.round(e.point.y)}`);
  };

  const sheet = useMemo(() => POOL.find((p) => p.id === press?.markerId) ?? null, [press]);

  return (
    <ScreenLayout
      map={
        <View style={{ flex: 1 }}>
          <DemoMap
            mapRef={map}
            world={WORLD}
            theme={{ base: 'toy', timeOfDay: 'day' }}
            labels={{ style: 'app' }}
            // Straight down on the station: the hero pin's tip lands on the centre of the map view.
            camera={{ center: STATION, pitch: 0, bearing: 0, distance: 320 }}
            location={{ source: 'external' }}
            onPress={(e) => pushLog(`map:press ${e.coordinate.lng.toFixed(5)},${e.coordinate.lat.toFixed(5)}`)}
            onBuildingPress={(e) => pushLog(`building:press ${e.buildingId}`)}
            onError={(e) => pushLog(`error ${e.code}${e.fatal ? ' (fatal)' : ''}: ${e.message}`)}
          >
            <MarkerLayer
              id="poi"
              data={pois}
              getId={(p) => p.id}
              getCoordinate={(p) => p.coordinate}
              getIcon={(p) => (p.partner ? STAR_ICON : p.id === HERO.id ? CAMERA_ICON : 'pin')}
              getColor={(p) => palette[p.faction]}
              getPriority={(p) => p.priority}
              getAlwaysVisible={(p) => partners && p.partner}
              getAccessibilityLabel={(p) => `${p.title}, ${p.faction}`}
              selectedId={selectedId}
              selectedScale={1.3}
              size={40}
              anchor="bottom"
              onPress={onMarkerPress}
            />
          </DemoMap>
          {press && sheet ? (
            // The integrator's use case: a sheet anchored at the reported screen point.
            <View
              testID="marker-sheet"
              pointerEvents="none"
              style={[styles.sheet, { left: Math.max(8, press.point.x - 90), top: Math.max(8, press.point.y + 10) }]}
            >
              <Text style={styles.sheetTitle}>{sheet.title}</Text>
              <Text style={styles.sheetBody}>
                {sheet.faction} · {Math.round(press.point.x)}, {Math.round(press.point.y)}
              </Text>
            </View>
          ) : null}
        </View>
      }
    >
      <Readout testID="marker-count">markers: {pois.length}</Readout>
      <Readout testID="marker-selected">selected: {selectedId ?? 'none'}</Readout>
      <Readout testID="marker-point">
        sheet at: {press ? `${Math.round(press.point.x)}, ${Math.round(press.point.y)}` : '—'}
      </Readout>
      <Readout testID="marker-tick">colour updates: {tick}</Readout>
      <Section title="Pin count (0 vs 60 is the performance before / after)">
        <Chips label="pins" options={COUNTS} value={count} onChange={setCount} testIDPrefix="markers-count" />
      </Section>
      <Section title="Partial updates (the 45 s server tick)">
        <ButtonRow>
          <Button title="Refresh colours & selection" testID="markers-refresh" onPress={refresh} />
          <Button title="Clear selection" testID="markers-clear" onPress={() => setSelectedId(null)} />
          <Button title="Select the station pin" testID="markers-select-hero" onPress={() => setSelectedId(HERO.id)} />
        </ButtonRow>
        <Toggle
          label="partner pins always visible (never hidden by collision)"
          value={partners}
          onChange={setPartners}
          testID="markers-partners"
        />
      </Section>
      <Section title="Events (a marker press never also reports the building or the ground)">
        <EventLog lines={log} testID="markers-log" />
      </Section>
    </ScreenLayout>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    width: 180,
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sheetTitle: { color: 'white', fontSize: 13, fontWeight: '700' },
  sheetBody: { color: '#cbd5e1', fontSize: 11, marginTop: 2, fontVariant: ['tabular-nums'] },
});
