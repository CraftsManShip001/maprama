import { useMemo, useRef, useState } from 'react';
import { InfoCard, MarkerLayer, type InfoCardAnchor, type InfoCardContent, type MapramaViewRef, type MarkerPressInfo } from '@maprama/react-native';
import type { LngLat } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, Toggle, useEventLog } from '../src/components/ui';
import { NAMED_POIS, SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

/** The camera looks a little north of the station, so the pins sit around the middle of the map. */
const CAMERA_TARGET: LngLat = offsetMeters(STATION, 0, 20);

interface Place {
  id: string;
  name: string;
  coordinate: LngLat;
  content: InfoCardContent;
}

const CATEGORY_CARDS: Record<string, Omit<InfoCardContent, 'title'>> = {
  cafe: {
    subtitle: '카페 · CAFE',
    icon: 'cafe',
    badges: [{ text: '영업 중', tone: 'good' }],
    rating: { value: 4.3, count: 1281 },
    rows: [
      { icon: 'hours', text: '22:00 영업 종료' },
      { icon: 'location', text: '성수동2가 273-13' },
      { icon: 'phone', text: '02-000-0000' },
    ],
    actions: [
      { id: 'route', label: '길찾기', primary: true },
      { id: 'call', label: '전화' },
    ],
  },
  music: {
    subtitle: '음반 · RECORDS',
    icon: 'music',
    badges: [{ text: '곧 마감', tone: 'warn' }],
    rating: { value: 4.6, count: 312 },
    rows: [
      { icon: 'hours', text: '21:00 영업 종료' },
      { icon: 'info', text: '오늘의 드롭 3곡' },
    ],
    actions: [
      { id: 'route', label: '길찾기', primary: true },
      { id: 'share', label: '공유' },
    ],
  },
  store: {
    subtitle: '편의점 · STORE',
    icon: 'store',
    badges: [{ text: '24시간', tone: 'good' }],
    rating: { value: 4.0, count: 87 },
    rows: [
      { icon: 'hours', text: '연중무휴' },
      { icon: 'info', text: '택배 접수 가능' },
    ],
    actions: [{ id: 'route', label: '길찾기', primary: true }],
  },
};

const FALLBACK: Omit<InfoCardContent, 'title'> = {
  subtitle: '장소 · PLACE',
  icon: 'plaza',
  badges: [{ text: '영업 종료', tone: 'bad' }],
  rating: { value: 3.9, count: 42 },
  rows: [
    { icon: 'hours', text: '내일 10:00 영업 시작' },
    { icon: 'location', text: '서울 성동구 성수동' },
  ],
  actions: [
    { id: 'route', label: '길찾기', primary: true },
    { id: 'call', label: '전화' },
  ],
};

/** The server's places: markers on the map, each with the card the app would show for it. */
const PLACES: Place[] = NAMED_POIS.slice(0, 8).map((p) => ({
  id: p.id,
  name: p.name,
  coordinate: p.coordinate,
  content: { title: p.name, ...(CATEGORY_CARDS[p.category] ?? FALLBACK) },
}));

const ANCHORS = ['auto', 'ground', 'roof'] as const;

export default function InfoCardScreen() {
  const map = useRef<MapramaViewRef>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<InfoCardAnchor>('auto');
  const [beam, setBeam] = useState(true);
  const [focusing, setFocusing] = useState(false);
  const [lastFocus, setLastFocus] = useState<string>('—');
  const [lastAction, setLastAction] = useState<string>('—');
  const [log, pushLog] = useEventLog();

  const open = useMemo(() => PLACES.find((p) => p.id === openId) ?? null, [openId]);

  /**
   * The whole "tap → camera → card" wiring, in the app. The engine does none of
   * it by itself: it reports the press, it moves the camera when asked, and it
   * draws the card that this component renders.
   */
  const openPlace = async (place: Place) => {
    setFocusing(true);
    pushLog(`marker:press ${place.id} → focusOn`);
    try {
      const result = await map.current!.focusOn(place.coordinate, { pitch: 55, heightMeters: 30, animate: true });
      setLastFocus(`${Math.round(result.camera.distance)} m · fitted ${result.fitted}${result.distanceLimited ? ' · limited' : ''}`);
      pushLog(`focusOn done: ${Math.round(result.camera.distance)} m, fitted=${result.fitted}`);
    } catch (e) {
      pushLog(`focusOn failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFocusing(false);
      // The card goes up after the camera arrived — the app's choice of order.
      setOpenId(place.id);
    }
  };

  const onMarkerPress = (e: MarkerPressInfo) => {
    const place = PLACES.find((p) => p.id === e.markerId);
    if (place) void openPlace(place);
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'modern', timeOfDay: 'day' }}
          labels={{ style: 'holo' }}
          camera={{ center: CAMERA_TARGET, pitch: 45, bearing: 20, distance: 320 }}
          location={{ source: 'external' }}
          onPress={() => pushLog('map:press (the card is still yours to close)')}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <MarkerLayer
            id="places"
            data={PLACES}
            getId={(p) => p.id}
            getCoordinate={(p) => p.coordinate}
            getAccessibilityLabel={(p) => p.name}
            selectedId={openId}
            onPress={onMarkerPress}
          />
          {open ? (
            <InfoCard
              id={open.id}
              coordinate={open.coordinate}
              anchor={anchor}
              beam={beam}
              dismissible
              content={open.content}
              onPress={(e) => {
                setLastAction(e.actionId ?? 'card');
                pushLog(`infoCard:press ${e.id}${e.actionId ? ` · ${e.actionId}` : ' · card body'}`);
              }}
              onDismiss={(e) => {
                pushLog(`infoCard:dismiss ${e.id} → the app removes it`);
                setOpenId(null);
              }}
            />
          ) : null}
        </DemoMap>
      }
    >
      <Readout testID="card-open">card: {open ? open.name : 'none'}</Readout>
      <Readout testID="card-focus">focusOn: {focusing ? 'moving…' : lastFocus}</Readout>
      <Readout testID="card-action">last action: {lastAction}</Readout>
      <Section title="Open a card (this is what your app does on a marker press)">
        <ButtonRow>
          {PLACES.slice(0, 3).map((p, i) => (
            <Button key={p.id} title={p.name} testID={`card-open-${i}`} onPress={() => void openPlace(p)} />
          ))}
        </ButtonRow>
        <ButtonRow>
          <Button title="Close the card" testID="card-close" onPress={() => setOpenId(null)} />
          <Button
            title="focusOn the open card"
            testID="card-focus-again"
            disabled={!open}
            onPress={() => {
              if (!open) return;
              void map.current
                ?.focusOn({ infoCardId: open.id }, { pitch: 55, animate: true })
                .then((r) => {
                  setLastFocus(`${Math.round(r.camera.distance)} m · fitted ${r.fitted}${r.distanceLimited ? ' · limited' : ''}`);
                  pushLog(`focusOn { infoCardId } done: ${Math.round(r.camera.distance)} m`);
                })
                .catch((e: unknown) => pushLog(`focusOn failed: ${e instanceof Error ? e.message : String(e)}`));
            }}
          />
        </ButtonRow>
      </Section>
      <Section title="Card options">
        <Chips label="anchor" options={ANCHORS} value={anchor} onChange={setAnchor} testIDPrefix="card-anchor" />
        <Toggle label="beam (ground dot + leader line)" value={beam} onChange={setBeam} testID="card-beam" />
      </Section>
      <Section title="Events (the engine never opens, focuses or closes a card on its own)">
        <EventLog lines={log} testID="card-log" />
      </Section>
    </ScreenLayout>
  );
}
