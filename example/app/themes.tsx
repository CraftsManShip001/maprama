import { useState } from 'react';
import {
  PRESET_NAMES,
  TIMES_OF_DAY,
  ZOOM_OUT_BEHAVIORS,
  type Massing,
  type PresetName,
  type ThemePreset,
  type ThemeSpec,
  type TimeOfDay,
  type ZoomOutBehavior,
} from '@maprama/protocol';
import urbanPresetJson from '@maprama/protocol/themes/urban.json';
import { DemoMap } from '../src/components/DemoMap';
import { Chips, Readout, ScreenLayout, Section, Toggle } from '../src/components/ui';
import { SEONGSU_WORLD, STATION } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;
/** A full preset object loaded from `@maprama/protocol/themes/*.json` (instead of a preset name). */
const URBAN_PRESET = urbanPresetJson as unknown as ThemePreset;

type BaseChoice = PresetName | 'urban.json';
const BASES: readonly BaseChoice[] = [...PRESET_NAMES, 'urban.json'];
const ZOOMS = ['near', 'far'] as const;
type Zoom = (typeof ZOOMS)[number];

export default function ThemesScreen() {
  const [base, setBase] = useState<BaseChoice>('realistic');
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>('day');
  const [cinematic, setCinematic] = useState(false);
  const [massing, setMassing] = useState<Massing>('varied');
  const [details, setDetails] = useState(true);
  const [zoomOut, setZoomOut] = useState<ZoomOutBehavior>('keepGameView');
  const [zoom, setZoom] = useState<Zoom>('near');

  const theme: ThemeSpec = {
    base: base === 'urban.json' ? URBAN_PRESET : base,
    timeOfDay,
    cinematic,
    buildings: { massing, details },
    zoomOut,
  };

  return (
    <ScreenLayout
      map={
        <DemoMap
          world={WORLD}
          theme={theme}
          camera={{ center: STATION, pitch: 55, distance: zoom === 'near' ? 140 : 900, animate: true }}
        />
      }
    >
      <Readout testID="theme-state">
        base: {base} · {timeOfDay} · cinematic {cinematic ? 'on' : 'off'} · {massing} · details {details ? 'on' : 'off'} · zoomOut {zoomOut}
      </Readout>
      <Section title="Preset">
        <Chips options={BASES} value={base} onChange={setBase} testIDPrefix="theme-base" />
      </Section>
      <Section title="Time of day">
        <Chips options={TIMES_OF_DAY} value={timeOfDay} onChange={setTimeOfDay} testIDPrefix="theme-time" />
        <Toggle label="Cinematic" value={cinematic} onChange={setCinematic} testID="theme-cinematic" />
      </Section>
      <Section title="Buildings">
        <Chips label="Massing" options={['box', 'varied'] as const} value={massing} onChange={setMassing} testIDPrefix="theme-massing" />
        <Toggle label="Facade details" value={details} onChange={setDetails} testID="theme-details" />
      </Section>
      <Section title="Zoom out">
        <Chips label="Behaviour" options={ZOOM_OUT_BEHAVIORS} value={zoomOut} onChange={setZoomOut} testIDPrefix="theme-zoomout" />
        <Chips label="Camera" options={ZOOMS} value={zoom} onChange={setZoom} testIDPrefix="theme-camera" labels={{ near: 'near (140 m)', far: 'far (900 m)' }} />
      </Section>
    </ScreenLayout>
  );
}
