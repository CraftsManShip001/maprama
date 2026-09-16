import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { MarkerLayer, useCameraIdle, type MapramaViewRef } from '@maprama/react-native';
import type { LngLat } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, EventLog, Readout, Section, useEventLog } from '../src/components/ui';
import { NAMED_POIS, SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

/** POIs the fake "server" knows about; the screen queries them by centre + radius. */
const POIS = NAMED_POIS;

/** The tourism app's grid: the centre is snapped to 0.005° before the query. */
const GRID_DEG = 0.005;
const snapToGrid = (c: LngLat): LngLat => ({
  lng: Math.round(c.lng / GRID_DEG) * GRID_DEG,
  lat: Math.round(c.lat / GRID_DEG) * GRID_DEG,
});

const meters = (a: LngLat, b: LngLat): number => {
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lng - a.lng) * 111320 * cosLat, (b.lat - a.lat) * 110540);
};

const deg = (v: number): string => v.toFixed(4);

/**
 * The first integrator's screen: a bottom sheet over half the display.
 *
 * Without `ui.contentInset` the sheet covers the engine-drawn `© OpenStreetMap`
 * attribution — a licensing problem, not a cosmetic one — and the camera centres
 * behind it. With the inset the engine keeps drawing the attribution and moves it
 * (and the scale bar, the zoom buttons, the labels and the camera centre) into the
 * visible half.
 *
 * `camera:idle` is the other half: one event when the map stops, carrying the
 * ground `bounds` and the `radiusMeters` a "POIs near here" query needs.
 */
export default function SheetScreen() {
  const map = useRef<MapramaViewRef>(null);
  const { height } = useWindowDimensions();
  const [insetOn, setInsetOn] = useState(false);
  const [count, setCount] = useState(0);
  const [log, pushLog] = useEventLog();
  const sheetHeight = Math.round(height * 0.5);

  const ui = useMemo(
    () => ({
      attribution: true,
      scaleBar: true,
      zoomButtons: true,
      ...(insetOn ? { contentInset: { bottom: sheetHeight } } : {}),
    }),
    [insetOn, sheetHeight],
  );

  const idle = useCameraIdle(map, { throttleMs: 0 });
  // Every idle event is one query: count them and log what the app would ask its server.
  const onIdle = useRef(pushLog);
  onIdle.current = pushLog;
  useEffect(() => {
    if (!idle) return;
    const cell = snapToGrid(idle.camera.center);
    setCount((n) => n + 1);
    onIdle.current(
      `idle (${idle.reason}) → GET /pois?lng=${deg(cell.lng)}&lat=${deg(cell.lat)}&r=${Math.round(idle.radiusMeters)}`,
    );
  }, [idle]);

  const visiblePois = idle ? POIS.filter((p) => meters(idle.camera.center, p.coordinate) <= idle.radiusMeters) : [];

  return (
    <View style={styles.screen}>
      <View style={StyleSheet.absoluteFill}>
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'urban', timeOfDay: 'day' }}
          labels={{ style: 'app' }}
          ui={ui}
          camera={{ center: STATION, distance: 700, pitch: 45, bearing: 0 }}
          location={{ source: 'external' }}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <MarkerLayer
            id="pois"
            data={POIS}
            getId={(p) => p.id}
            getCoordinate={(p) => p.coordinate}
            getColor={() => '#E0452F'}
            getAccessibilityLabel={(p) => p.name ?? p.id}
            size={30}
          />
        </DemoMap>
      </View>

      {/* The app's bottom sheet: opaque, half the display, drawn over the map. */}
      <View testID="sheet" style={[styles.sheet, { height: sheetHeight }]}>
        <View style={styles.grabber} />
        <Pressable
          testID="inset-toggle"
          accessibilityRole="switch"
          accessibilityState={{ checked: insetOn }}
          onPress={() => setInsetOn((v) => !v)}
          style={[styles.toggle, insetOn && styles.toggleOn]}
        >
          <Text style={[styles.toggleText, insetOn && styles.toggleTextOn]}>
            content inset: {insetOn ? `on (${sheetHeight} dp)` : 'off'}
          </Text>
        </Pressable>
        <ScrollView testID="panel" contentContainerStyle={styles.sheetContent}>
          <Readout testID="idle-count">camera:idle events: {count}</Readout>
          <Readout testID="idle-reason">reason: {idle ? idle.reason : '—'}</Readout>
          <Readout testID="idle-center">
            center: {idle ? `${deg(idle.camera.center.lng)}, ${deg(idle.camera.center.lat)}` : '—'}
          </Readout>
          <Readout testID="idle-radius">radius: {idle ? `${Math.round(idle.radiusMeters)} m` : '—'}</Readout>
          <Readout testID="idle-bounds">
            bounds:{' '}
            {idle
              ? `${deg(idle.bounds.sw.lng)},${deg(idle.bounds.sw.lat)} → ${deg(idle.bounds.ne.lng)},${deg(idle.bounds.ne.lat)}`
              : '—'}
          </Readout>
          <Readout testID="idle-pois">
            POIs within the radius: {idle ? `${visiblePois.length} of ${POIS.length}` : '—'}
          </Readout>
          <Section title="Move the camera (reason: api)">
            <ButtonRow>
              <Button
                title="Fly north"
                testID="idle-move-north"
                onPress={() =>
                  map.current?.setCamera({ center: offsetMeters(STATION, 0, 400), animate: true })
                }
              />
              <Button
                title="Back to the station"
                testID="idle-move-back"
                onPress={() => map.current?.setCamera({ center: STATION, distance: 700, animate: true })}
              />
            </ButtonRow>
          </Section>
          <Section title="Events">
            <EventLog lines={log} testID="idle-log" />
          </Section>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#dfe6ee' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
    elevation: 12,
  },
  grabber: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: '#cbd5e1', marginBottom: 8 },
  sheetContent: { paddingHorizontal: 14, paddingBottom: 28 },
  toggle: { alignSelf: 'flex-start', marginLeft: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, backgroundColor: '#e2e8f0' },
  toggleOn: { backgroundColor: '#2f5bea' },
  toggleText: { fontSize: 13, color: '#0f172a', fontWeight: '600' },
  toggleTextOn: { color: 'white' },
});
