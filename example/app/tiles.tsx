import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import type { LngLat, TileWorldSource } from '@maprama/protocol';
import { useCameraIdle, type MapramaViewRef } from '@maprama/react-native';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, styles, useEventLog } from '../src/components/ui';
import { TILES_URL } from '../src/config';

/**
 * A country-sized map from one PMTiles archive: the engine fetches only the
 * tiles the camera is looking at, over HTTP range requests.
 *
 * The point of the screen is the **travelling**. Flying from Seoul to Busan is
 * 325 km, which moves the map far beyond what a float32 vertex buffer can hold
 * accurately, so the engine re-bases its render anchor along the way. Nothing
 * on this screen knows or cares: every coordinate here is a plain `{ lng, lat }`,
 * and the camera, the markers and the labels stay where they belong. If a
 * re-base were visible, this is the screen it would be visible on.
 */
const PLACES: { id: string; label: string; at: LngLat; distance: number }[] = [
  { id: 'seoul', label: 'Seoul', at: { lng: 126.978, lat: 37.5665 }, distance: 700 },
  { id: 'incheon', label: 'Incheon', at: { lng: 126.7052, lat: 37.4563 }, distance: 700 },
  { id: 'daejeon', label: 'Daejeon', at: { lng: 127.3845, lat: 36.3504 }, distance: 700 },
  { id: 'gwangju', label: 'Gwangju', at: { lng: 126.8526, lat: 35.1595 }, distance: 700 },
  { id: 'busan', label: 'Busan', at: { lng: 129.0756, lat: 35.1796 }, distance: 700 },
];

/** Far enough out that the archive's overview level takes over. */
const COUNTRY_VIEW_METERS = 7000;

export default function TilesScreen() {
  const map = useRef<MapramaViewRef | null>(null);
  const [place, setPlace] = useState('seoul');
  const [log, pushLog] = useEventLog();
  const idle = useCameraIdle(map, { throttleMs: 0 });
  const [camera, setCamera] = useState<string>('—');
  useEffect(() => {
    if (!idle) return;
    setCamera(`${idle.camera.center.lat.toFixed(4)}, ${idle.camera.center.lng.toFixed(4)} · ${Math.round(idle.camera.distance)} m · ${idle.reason}`);
  }, [idle]);

  const flyTo = async (id: string) => {
    const target = PLACES.find((p) => p.id === id);
    if (!target || !map.current) return;
    setPlace(id);
    pushLog(`fly to ${target.label}`);
    // One animated move across the whole country. Everything in between
    // streams in and out, and the render anchor moves several times.
    await map.current.setCamera({ center: target.at, distance: target.distance, pitch: 50, bearing: 20, animate: { durationMs: 2500 } });
  };

  if (!TILES_URL) {
    return (
      <ScreenLayout
        map={
          <Text testID="tiles-url-missing" style={[styles.readout, { padding: 16 }]}>
            No tile archive configured. Set EXPO_PUBLIC_MAPRAMA_TILES_URL to a PMTiles archive built with the tile
            pipeline (see docs/guide/tile-worlds). The host must answer HTTP range requests and send
            Access-Control-Allow-Origin: * plus Access-Control-Expose-Headers: Content-Range, Content-Length, ETag,
            Accept-Ranges. Skipped.
          </Text>
        }
      >
        <Section title="Tile world">
          <Readout testID="tiles-state">not configured</Readout>
        </Section>
      </ScreenLayout>
    );
  }

  const world: TileWorldSource = {
    kind: 'tiles',
    url: TILES_URL,
    // A tile world has no origin of its own: the host says where it opens.
    center: PLACES[0]!.at,
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          // Only the web engine streams tiles today; the native engine answers
          // `unsupported` for this world rather than drawing an empty map.
          engine="web"
          world={world}
          theme={{ base: 'urban', timeOfDay: 'golden' }}
          camera={{ center: PLACES[0]!.at, distance: PLACES[0]!.distance, pitch: 50, bearing: 20, maxDistanceMeters: COUNTRY_VIEW_METERS }}
          labels={{ style: 'holo' }}
          ui={{ attribution: true, scaleBar: true, zoomButtons: true }}
          onReady={() => pushLog('ready: streaming tiles')}
          // A tile that will not load is `tile_load_failed` and not fatal: the
          // map keeps running with a hole in it.
          onError={(e) => pushLog(`${e.fatal ? 'fatal ' : ''}${e.code}: ${e.message}`)}
        />
      }
    >
      <Section title="Fly across the country">
        <Chips
          options={PLACES.map((p) => p.id)}
          value={place}
          onChange={(id) => void flyTo(id)}
          testIDPrefix="tiles-place"
          labels={Object.fromEntries(PLACES.map((p) => [p.id, p.label]))}
        />
        <ButtonRow>
          <Button
            title="Whole country"
            testID="tiles-country"
            onPress={() => {
              pushLog('zoom out to the overview level');
              // The archive's overview level only comes into play this far out,
              // which is why the map raised `maxDistanceMeters` above.
              void map.current?.setCamera({ center: { lng: 127.8, lat: 36.4 }, distance: COUNTRY_VIEW_METERS, pitch: 30, animate: { durationMs: 2000 } });
            }}
          />
          <Button
            title="Mountains (no tiles)"
            testID="tiles-empty"
            onPress={() => {
              // An archive stores nothing where the map has nothing. This is
              // empty ground, not an error and not a blank screen.
              pushLog('fly to a region the archive has no tiles for');
              void map.current?.setCamera({ center: { lng: 128.5433, lat: 37.7947 }, distance: 900, pitch: 45, animate: { durationMs: 2000 } });
            }}
          />
        </ButtonRow>
        <Readout testID="tiles-camera">{camera}</Readout>
      </Section>
      <Section title="Events">
        <EventLog testID="tiles-log" lines={log} />
      </Section>
    </ScreenLayout>
  );
}
