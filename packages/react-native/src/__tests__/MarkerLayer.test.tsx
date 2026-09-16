import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import type { LngLat } from '@maprama/protocol';
import { MapramaView, MarkerLayer, resolveMarkerIcon } from '../index';
import { READY, clearPosted, commands, commandTypes, commandsOf, emit, nextFrame, webViewInstances } from './helpers';

const WORLD = { kind: 'procedural', layout: 'town' } as const;
const A: LngLat = { lng: 127.056, lat: 37.544 };
const B: LngLat = { lng: 127.058, lat: 37.545 };
const SVG = 'data:image/svg+xml;base64,PHN2Zy8+';

interface Poi {
  id: string;
  coord: LngLat;
  faction: 'blue' | 'red';
  title: string;
  partner?: boolean;
  rank?: number;
}

const FACTION = { blue: '#2F5BEA', red: '#E0452F' } as const;

const POIS: Poi[] = [
  { id: 'p1', coord: A, faction: 'blue', title: 'Palace', rank: 10, partner: true },
  { id: 'p2', coord: B, faction: 'red', title: 'Market', rank: 3 },
];

beforeEach(() => {
  webViewInstances.length = 0;
});

function tree(pois: Poi[], selectedId: string | null = null, palette: Record<Poi['faction'], string> = FACTION) {
  return (
    <MapramaView world={WORLD}>
      <MarkerLayer
        id="poi"
        data={pois}
        getId={(p) => p.id}
        getCoordinate={(p) => p.coord}
        getIcon={() => ({ uri: SVG })}
        getColor={(p) => palette[p.faction]}
        getPriority={(p) => p.rank}
        getAlwaysVisible={(p) => p.partner}
        getAccessibilityLabel={(p) => `${p.title}, ${p.faction}`}
        selectedId={selectedId}
        selectedScale={1.25}
        size={36}
        anchor="bottom"
        onPress={() => {}}
      />
    </MapramaView>
  );
}

describe('MarkerLayer', () => {
  it('sends the resolved markers with setMarkerLayer', async () => {
    const { unmount } = await render(tree(POIS, 'p1'));
    await emit(READY);
    await nextFrame();
    expect(commandsOf('setMarkerLayer')).toEqual([
      {
        type: 'setMarkerLayer',
        layerId: 'poi',
        markers: [
          {
            id: 'p1',
            coordinate: A,
            icon: { uri: SVG },
            color: '#2F5BEA',
            priority: 10,
            alwaysVisible: true,
            accessibilityLabel: 'Palace, blue',
          },
          { id: 'p2', coordinate: B, icon: { uri: SVG }, color: '#E0452F', priority: 3, accessibilityLabel: 'Market, red' },
        ],
        selectedId: 'p1',
        selectedScale: 1.25,
        size: 36,
        anchor: 'bottom',
      },
    ]);
    await unmount();
  });

  it('sends one minimal setMarkerLayer for a colour-only change and nothing for an unchanged re-render', async () => {
    const { rerender, unmount } = await render(tree(POIS, 'p1'));
    await emit(READY);
    await nextFrame();
    const before = commandsOf('setMarkerLayer')[0]!;

    // Re-rendering with equal data sends nothing at all.
    clearPosted();
    await rerender(tree([...POIS.map((p) => ({ ...p }))], 'p1'));
    await nextFrame();
    expect(commands()).toEqual([]);

    // A colour-only change: exactly one setMarkerLayer for this layer, and the
    // only difference is the colours — ids, coordinates and icons are identical,
    // so the engine updates views in place instead of recreating them.
    clearPosted();
    // Only the palette moves: ids, coordinates, icons and labels are untouched.
    const palette = { blue: '#E0452F', red: '#2F5BEA' } as const;
    await rerender(tree(POIS, 'p1', palette));
    await nextFrame();
    expect(commandTypes()).toEqual(['setMarkerLayer']);
    const after = commandsOf('setMarkerLayer')[0]!;
    expect(after.markers.map((m) => m.color)).toEqual(['#E0452F', '#2F5BEA']);
    expect(after.markers.map(({ color, ...rest }) => rest)).toEqual(before.markers.map(({ color, ...rest }) => rest));
    expect({ ...after, markers: [] }).toEqual({ ...before, markers: [] });

    // A selection-only change is likewise one command whose markers are unchanged.
    clearPosted();
    await rerender(tree(POIS, 'p2', palette));
    await nextFrame();
    expect(commandTypes()).toEqual(['setMarkerLayer']);
    expect(commandsOf('setMarkerLayer')[0]!.selectedId).toBe('p2');
    expect(commandsOf('setMarkerLayer')[0]!.markers).toEqual(after.markers);
    await unmount();
  });

  it('removes the layer on unmount and omits absent options', async () => {
    const { rerender, unmount } = await render(
      <MapramaView world={WORLD}>
        <MarkerLayer id="poi" data={POIS} getId={(p) => p.id} getCoordinate={(p) => p.coord} />
      </MapramaView>,
    );
    await emit(READY);
    await nextFrame();
    expect(commandsOf('setMarkerLayer')[0]).toEqual({
      type: 'setMarkerLayer',
      layerId: 'poi',
      markers: [
        { id: 'p1', coordinate: A },
        { id: 'p2', coordinate: B },
      ],
    });

    clearPosted();
    await rerender(<MapramaView world={WORLD} />);
    await nextFrame();
    expect(commands()).toEqual([{ type: 'removeMarkerLayer', layerId: 'poi' }]);
    await unmount();
  });

  it('routes marker:press of its own layer to onPress and never to the map handlers', async () => {
    const onPress = jest.fn();
    const onMapPress = jest.fn();
    const onBuildingPress = jest.fn();
    const { unmount } = await render(
      <MapramaView world={WORLD} onPress={onMapPress} onBuildingPress={onBuildingPress}>
        <MarkerLayer id="poi" data={POIS} getId={(p) => p.id} getCoordinate={(p) => p.coord} onPress={onPress} />
      </MapramaView>,
    );
    await emit(READY);
    await nextFrame();

    await emit({ type: 'marker:press', layerId: 'poi', markerId: 'p2', coordinate: B, point: { x: 180.5, y: 402 } });
    await emit({ type: 'marker:press', layerId: 'other', markerId: 'x', coordinate: A, point: { x: 1, y: 2 } });

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith({
      layerId: 'poi',
      markerId: 'p2',
      coordinate: B,
      point: { x: 180.5, y: 402 },
    });
    expect(onMapPress).not.toHaveBeenCalled();
    expect(onBuildingPress).not.toHaveBeenCalled();
    await unmount();
  });

  it('keeps several layers independent', async () => {
    const { rerender, unmount } = await render(
      <MapramaView world={WORLD}>
        <MarkerLayer id="poi" data={POIS} getId={(p) => p.id} getCoordinate={(p) => p.coord} getColor={(p) => FACTION[p.faction]} />
        <MarkerLayer id="stops" data={[POIS[0]!]} getId={(p) => p.id} getCoordinate={(p) => p.coord} />
      </MapramaView>,
    );
    await emit(READY);
    await nextFrame();
    expect(commandsOf('setMarkerLayer').map((c) => c.layerId)).toEqual(['poi', 'stops']);

    clearPosted();
    await rerender(
      <MapramaView world={WORLD}>
        <MarkerLayer id="poi" data={POIS} getId={(p) => p.id} getCoordinate={(p) => p.coord} getColor={() => '#000000'} />
        <MarkerLayer id="stops" data={[POIS[0]!]} getId={(p) => p.id} getCoordinate={(p) => p.coord} />
      </MapramaView>,
    );
    await nextFrame();
    expect(commandsOf('setMarkerLayer').map((c) => c.layerId)).toEqual(['poi']);
    await unmount();
  });
});

describe('resolveMarkerIcon', () => {
  it('keeps base shapes, wraps URIs and drops empty input', () => {
    expect(resolveMarkerIcon('pin')).toBe('pin');
    expect(resolveMarkerIcon('dot')).toBe('dot');
    expect(resolveMarkerIcon(SVG)).toEqual({ uri: SVG });
    expect(resolveMarkerIcon({ uri: 'https://cdn.example/p.svg' })).toEqual({ uri: 'https://cdn.example/p.svg' });
    expect(resolveMarkerIcon(undefined)).toBeUndefined();
    expect(resolveMarkerIcon(null)).toBeUndefined();
    expect(resolveMarkerIcon('')).toBeUndefined();
    expect(resolveMarkerIcon({ uri: '' })).toBeUndefined();
  });
});
