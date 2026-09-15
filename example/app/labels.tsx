import { useEffect, useRef, useState } from 'react';
import { type DioramaMapRef, type LabelContentFunction } from '@diorama/react-native';
import { HOLO_ICON_TILES, LABEL_CONTENT_MODES, LABEL_STYLES, type HoloIconTile, type LabelContentMode, type LabelStyle } from '@diorama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, Readout, ScreenLayout, Section, Toggle } from '../src/components/ui';
import { SEONGSU_WORLD, STATION } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;

type ContentChoice = Exclude<LabelContentMode, 'custom'> | 'function';
const CONTENT_CHOICES: readonly ContentChoice[] = [...LABEL_CONTENT_MODES.filter((m): m is Exclude<LabelContentMode, 'custom'> => m !== 'custom'), 'function'];

export default function LabelsScreen() {
  const map = useRef<DioramaMapRef>(null);
  const [enabled, setEnabled] = useState(true);
  const [style, setStyle] = useState<LabelStyle>('app');
  const [icons, setIcons] = useState<HoloIconTile>('auto');
  const [content, setContent] = useState<ContentChoice>('nameAndType');
  const [dropsToday, setDropsToday] = useState(3);
  const dropsRef = useRef(dropsToday);
  dropsRef.current = dropsToday;

  /** Custom content, evaluated in JS once per labelsIndex / labels change / refreshLabelContent(). */
  const customContent: LabelContentFunction = (label) => {
    if (label.kind !== 'poi') return null;
    if (label.category === 'music' || label.category === 'cafe') {
      return { title: label.name, subtitle: `${dropsRef.current} drops today`, icon: 'music' };
    }
    return { title: label.name.toUpperCase(), subtitle: label.category, ...(label.category ? { icon: label.category } : {}) };
  };

  // The function reads `dropsRef`; changing that data needs an explicit refresh.
  useEffect(() => {
    map.current?.refreshLabelContent();
  }, [dropsToday]);

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'realistic', timeOfDay: style === 'holo' ? 'night' : 'day' }}
          camera={{ center: STATION, pitch: 55, distance: 180 }}
          labels={{ enabled, style, icons, content: content === 'function' ? customContent : content }}
        />
      }
    >
      <Readout testID="labels-state">
        style: {style} · icons: {icons} · content: {content} · {enabled ? 'shown' : 'hidden'}
      </Readout>
      <Section title="Style">
        <Chips options={LABEL_STYLES} value={style} onChange={setStyle} testIDPrefix="labels-style" />
        <Toggle label="Labels" value={enabled} onChange={setEnabled} testID="labels-enabled" />
      </Section>
      <Section title="Icon tiles (holo)">
        <Chips options={HOLO_ICON_TILES} value={icons} onChange={setIcons} testIDPrefix="labels-icons" />
      </Section>
      <Section title="Content">
        <Chips options={CONTENT_CHOICES} value={content} onChange={setContent} testIDPrefix="labels-content" labels={{ function: 'custom function' }} />
        {content === 'function' ? (
          <ButtonRow>
            <Button title={`More drops today (${dropsToday}) + refreshLabelContent()`} testID="labels-refresh" onPress={() => setDropsToday((n) => n + 1)} />
          </ButtonRow>
        ) : null}
      </Section>
    </ScreenLayout>
  );
}
