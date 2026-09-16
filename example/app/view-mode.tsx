import { useRef, useState } from 'react';
import { VIEW_MODES, type ViewMode } from '@maprama/react-native';
import type { MapramaErrorEvent, MapramaViewRef } from '@maprama/react-native';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, Toggle, useEventLog } from '../src/components/ui';
import { SEONGSU_WORLD, STATION } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;
const TILTED_PITCH = 50;

/**
 * 2D ⇄ 2.5D, both ways an app can drive it.
 *
 * - **Declarative**: the `view` prop. Flipping the chips re-renders and the
 *   library sends one `setView`; React state stays the source of truth.
 * - **Imperative**: `ref.setView(...)`, which resolves when the transition has
 *   settled — the "measure after" button waits on it before reading the camera.
 *
 * The screen also shows the two rules that are easy to get wrong:
 * `setCamera({ pitch })` in 2D is **refused** with a non-fatal
 * `view_pitch_locked` error (the rest of the camera still applies), and the
 * pitch gesture is locked, so a two-finger drag cannot tilt a map that claims
 * to be flat.
 */
export default function ViewModeScreen() {
  const map = useRef<MapramaViewRef | null>(null);
  const [view, setView] = useState<ViewMode>('2.5d');
  const [animate, setAnimate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [logLines, log] = useEventLog();

  /** Imperative switch: send it, then wait for the transition to land. */
  const switchTo = async (next: ViewMode) => {
    setBusy(true);
    const started = Date.now();
    await map.current?.setView(next, animate ? { durationMs: 450 } : { animate: false });
    // Only now is the map really in `next`: safe to measure, screenshot or fit.
    log(`ref.setView('${next}') settled after ${Date.now() - started} ms`);
    setView(next);
    setBusy(false);
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          view={view}
          theme={{ base: 'urban', timeOfDay: 'day' }}
          labels={{ enabled: true, style: 'holo' }}
          camera={{ center: STATION, distance: 320 }}
          ui={{ zoomButtons: true }}
          onError={(e: MapramaErrorEvent) => {
            if (e.code === 'view_pitch_locked') log(`refused: ${e.message}`);
          }}
        />
      }
    >
      <Readout testID="view-state">
        view: {view} · transition {animate ? 'animated (450 ms)' : 'instant'} · pitch {view === '2d' ? 'locked at 0°' : `free (0–60°, tilted preset ${TILTED_PITCH}°)`}
      </Readout>

      <Section title="Declarative (the view prop)">
        <Chips
          options={VIEW_MODES}
          value={view}
          onChange={setView}
          testIDPrefix="view-mode"
          labels={{ '2.5d': '2.5D diorama', '2d': '2D map' }}
        />
        <Toggle label="Animate transitions" value={animate} onChange={setAnimate} testID="view-animate" />
      </Section>

      <Section title="Imperative (ref.setView, awaited)">
        <ButtonRow>
          <Button title="→ 2D, then log" testID="view-ref-2d" disabled={busy} onPress={() => void switchTo('2d')} />
          <Button title="→ 2.5D, then log" testID="view-ref-25d" disabled={busy} onPress={() => void switchTo('2.5d')} />
        </ButtonRow>
      </Section>

      <Section title="Pitch in 2D">
        <ButtonRow>
          {/* In 2.5D this tilts the camera; in 2D it is refused with `view_pitch_locked`
              and only the distance is applied — never silently obeyed. */}
          <Button
            title={`setCamera pitch ${TILTED_PITCH}°`}
            testID="view-try-pitch"
            onPress={() => map.current?.setCamera({ pitch: TILTED_PITCH, animate: true })}
          />
        </ButtonRow>
      </Section>

      <EventLog testID="view-log" lines={logLines} />
    </ScreenLayout>
  );
}
