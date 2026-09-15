import { useState } from 'react';
import { Text } from 'react-native';
import type { WorldSource } from '@maprama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Chips, EventLog, Readout, ScreenLayout, Section, styles, useEventLog } from '../src/components/ui';
import { WORLD_URL } from '../src/config';
import { SEONGSU_WORLD, STATION } from '../src/data/seongsu';

const SOURCES = ['data', 'url', 'town', 'grid'] as const;
type SourceChoice = (typeof SOURCES)[number];

function worldFor(choice: SourceChoice): WorldSource | null {
  switch (choice) {
    case 'data':
      return { kind: 'data', world: SEONGSU_WORLD };
    case 'url':
      return WORLD_URL ? { kind: 'url', url: WORLD_URL } : null;
    case 'town':
      return { kind: 'procedural', layout: 'town', seed: 7 };
    case 'grid':
      return { kind: 'procedural', layout: 'grid', seed: 7 };
  }
}

export default function WorldScreen() {
  const [choice, setChoice] = useState<SourceChoice>('data');
  const [log, pushLog] = useEventLog();
  const world = worldFor(choice);
  const real = choice === 'data' || choice === 'url';

  return (
    <ScreenLayout
      map={
        world ? (
          // `world` is read at init, so a new source remounts the map.
          <DemoMap
            key={choice}
            world={world}
            theme={{ base: real ? 'realistic' : 'toy', timeOfDay: 'golden' }}
            camera={real ? { center: STATION, pitch: 50, distance: 260 } : { pitch: 50, distance: 260 }}
            ui={{ attribution: real }}
            onReady={(e) => pushLog(`ready: ${choice} (engine ${e.engine.version ?? ''})`)}
            onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
          />
        ) : (
          <Text testID="world-url-missing" style={[styles.readout, { padding: 16 }]}>
            No world URL configured. Start the local API (see example/README.md) and set EXPO_PUBLIC_MAPRAMA_API_KEY, or set EXPO_PUBLIC_MAPRAMA_WORLD_URL. Skipped.
          </Text>
        )
      }
    >
      <Section title="World source">
        <Chips
          options={SOURCES}
          value={choice}
          onChange={setChoice}
          testIDPrefix="world-source"
          labels={{ data: "data (bundled Seongsu)", url: 'url (local API)', town: 'procedural town', grid: 'procedural grid' }}
        />
        <Readout testID="world-state">
          {choice === 'data'
            ? `Seongsu-dong OSM sample: ${SEONGSU_WORLD.buildings.length} buildings, ${SEONGSU_WORLD.roads.length} roads, ${SEONGSU_WORLD.pois.length} POIs (ODbL)`
            : choice === 'url'
              ? `url: ${WORLD_URL ? WORLD_URL.replace(/key=[^&]+/, 'key=***') : '(not configured)'}`
              : `procedural ${choice}, seed 7`}
        </Readout>
      </Section>
      <Section title="Events">
        <EventLog lines={log} testID="world-log" />
      </Section>
    </ScreenLayout>
  );
}
