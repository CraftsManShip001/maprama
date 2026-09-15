import { useEffect, useRef, useState } from 'react';
import { Character, Geofence, type DioramaMapRef } from '@diorama/react-native';
import { ROOF_SHAPES, type BuildingStyle, type LngLat, type LocationSourceKind, type Massing, type RoofShape } from '@diorama/protocol';
import { DemoMap } from '../src/components/DemoMap';
import { Button, ButtonRow, Chips, EventLog, Readout, ScreenLayout, Section, Toggle, useEventLog } from '../src/components/ui';
import { SAMPLE_BUILDING, SEONGSU_WORLD, STATION, offsetMeters } from '../src/data/seongsu';

const WORLD = { kind: 'data', world: SEONGSU_WORLD } as const;
const PLAZA = STATION;
const PLAZA_RADIUS = 60;
const OUTSIDE = offsetMeters(PLAZA, 0, -150);
const COLORS = ['#FF8800', '#2F5BEA', '#22AA66', '#E0457B'] as const;
type Color = (typeof COLORS)[number];

interface Editor {
  color: Color;
  roof: RoofShape;
  massing: Massing;
  captured: boolean;
  facade: boolean;
}

export default function BuildingsScreen() {
  const map = useRef<DioramaMapRef>(null);
  const [source, setSource] = useState<Extract<LocationSourceKind, 'simulated' | 'external'>>('external');
  const [inside, setInside] = useState(false);
  const [log, pushLog] = useEventLog();
  const [building, setBuilding] = useState<{ id: string; coordinate: LngLat } | null>(null);
  const [editor, setEditor] = useState<Editor>({ color: '#FF8800', roof: 'gable', massing: 'varied', captured: true, facade: true });

  const teleport = (to: LngLat) => {
    for (let i = 0; i < 4; i++) {
      setTimeout(() => map.current?.pushLocation({ lng: to.lng, lat: to.lat, accuracyMeters: 3, timestamp: Date.now() }), i * 250);
    }
  };

  // Apply the editor to the selected building on every change.
  useEffect(() => {
    if (!building) return;
    const style: BuildingStyle = {
      color: editor.color,
      roof: editor.roof,
      massing: editor.massing,
      facade: editor.facade,
      ...(editor.captured ? { state: 'captured' } : {}),
    };
    map.current?.setBuildingStyle(building.id, style);
  }, [building, editor]);

  const update = <K extends keyof Editor>(key: K, value: Editor[K]) => setEditor((prev) => ({ ...prev, [key]: value }));

  return (
    <ScreenLayout
      map={
        <DemoMap
          mapRef={map}
          world={WORLD}
          theme={{ base: 'realistic', timeOfDay: 'golden', buildings: { massing: 'varied' } }}
          ui={{ locationPuck: true }}
          location={{ source }}
          onReady={() => {
            map.current?.setCamera({ follow: 'me', pitch: 55, distance: 220 });
            if (source === 'external') teleport(OUTSIDE);
          }}
          onBuildingPress={(e) => {
            setBuilding({ id: e.buildingId, coordinate: e.coordinate });
            pushLog(`building pressed: ${e.buildingId}`);
          }}
          onError={(e) => pushLog(`error ${e.code}: ${e.message}`)}
        >
          <Character id="me" isPlayer name="Scout" showNameTag color="#2F5BEA" follow="location" />
          <Geofence
            id="plaza"
            center={PLAZA}
            radiusMeters={PLAZA_RADIUS}
            onEnter={(e) => {
              setInside(true);
              pushLog(`enter ${e.geofenceId} (${e.characterId})`);
            }}
            onExit={(e) => {
              setInside(false);
              pushLog(`exit ${e.geofenceId} (${e.characterId})`);
            }}
          />
        </DemoMap>
      }
    >
      <Readout testID="geofence-state">plaza ({PLAZA_RADIUS} m): {inside ? 'inside' : 'outside'}</Readout>
      <Section title="Geofence">
        <Chips
          label="Location source"
          options={['external', 'simulated'] as const}
          value={source}
          onChange={setSource}
          testIDPrefix="geofence-source"
        />
        {source === 'external' ? (
          <ButtonRow>
            <Button title="Enter plaza" testID="geofence-enter" onPress={() => teleport(PLAZA)} />
            <Button title="Leave plaza" testID="geofence-exit" onPress={() => teleport(OUTSIDE)} />
          </ButtonRow>
        ) : null}
        <EventLog lines={log} testID="geofence-log" />
      </Section>
      <Section title="Building style (press a building on the map)">
        <ButtonRow>
          <Button
            title={`Pick sample building${SAMPLE_BUILDING ? ` (${SAMPLE_BUILDING.name})` : ''}`}
            testID="pick-building"
            disabled={!SAMPLE_BUILDING}
            onPress={() => {
              if (!SAMPLE_BUILDING) return;
              setBuilding({ id: SAMPLE_BUILDING.id, coordinate: SAMPLE_BUILDING.coordinate });
              map.current?.setCamera({ follow: null, center: SAMPLE_BUILDING.coordinate, distance: 120, animate: true });
              pushLog(`picked ${SAMPLE_BUILDING.id}`);
            }}
          />
          {building ? (
            <Button
              title="Reset style"
              testID="building-reset"
              onPress={() => {
                map.current?.setBuildingStyle(building.id, null);
                pushLog(`reset ${building.id}`);
                setBuilding(null);
              }}
            />
          ) : null}
        </ButtonRow>
        <Readout testID="building-selected">selected: {building ? building.id : 'none'}</Readout>
        {building ? (
          <>
            <Chips label="Color" options={COLORS} value={editor.color} onChange={(v) => update('color', v)} testIDPrefix="building-color" />
            <Chips label="Roof" options={ROOF_SHAPES} value={editor.roof} onChange={(v) => update('roof', v)} testIDPrefix="building-roof" />
            <Chips label="Massing" options={['box', 'varied'] as const} value={editor.massing} onChange={(v) => update('massing', v)} testIDPrefix="building-massing" />
            <Toggle label="State captured" value={editor.captured} onChange={(v) => update('captured', v)} testID="building-captured" />
            <Toggle label="Facade" value={editor.facade} onChange={(v) => update('facade', v)} testID="building-facade" />
          </>
        ) : null}
      </Section>
    </ScreenLayout>
  );
}
