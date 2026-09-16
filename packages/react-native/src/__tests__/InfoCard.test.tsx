import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import type { InfoCardContent, LngLat } from '@maprama/protocol';
import { InfoCard, MapramaView, type MapramaViewRef } from '../index';
import { createRef } from 'react';
import { READY, clearPosted, commandTypes, commands, commandsOf, emit, latestWebView, nextFrame, webViewInstances } from './helpers';

const WORLD = { kind: 'procedural', layout: 'town' } as const;
const A: LngLat = { lng: 127.056, lat: 37.544 };
const B: LngLat = { lng: 127.058, lat: 37.545 };

const CONTENT: InfoCardContent = {
  title: '스타벅스 판교점',
  subtitle: '카페',
  icon: 'cafe',
  badges: [{ text: '영업 중', tone: 'good' }],
  rating: { value: 4.3, count: 1281 },
  rows: [
    { icon: 'hours', text: '22:00 영업 종료' },
    { icon: 'phone', text: '031-000-0000' },
  ],
  actions: [
    { id: 'route', label: '길찾기', primary: true },
    { id: 'call', label: '전화' },
  ],
};

beforeEach(() => {
  webViewInstances.length = 0;
});

describe('InfoCard', () => {
  it('sends one setInfoCard per card and removeInfoCard on unmount', async () => {
    function Tree({ show }: { show: boolean }) {
      return (
        <MapramaView world={WORLD}>
          <InfoCard id="a" coordinate={A} anchor="roof" heightMeters={12} dismissible content={CONTENT} />
          {show ? <InfoCard id="b" coordinate={B} beam={false} content={{ title: 'Second' }} /> : null}
        </MapramaView>
      );
    }
    const { rerender, unmount } = await render(<Tree show />);
    await emit(READY);
    await nextFrame();
    expect(commandsOf('setInfoCard')).toEqual([
      {
        type: 'setInfoCard',
        card: { id: 'a', coordinate: A, anchor: 'roof', heightMeters: 12, dismissible: true, content: CONTENT },
      },
      { type: 'setInfoCard', card: { id: 'b', coordinate: B, beam: false, content: { title: 'Second' } } },
    ]);

    // Unmounting one card removes only that one.
    clearPosted();
    await rerender(<Tree show={false} />);
    await nextFrame();
    expect(commands()).toEqual([{ type: 'removeInfoCard', id: 'b' }]);
    await unmount();
  });

  it('sends nothing for an unchanged re-render and only the changed card otherwise', async () => {
    function Tree({ title }: { title: string }) {
      return (
        <MapramaView world={WORLD}>
          <InfoCard id="a" coordinate={A} content={CONTENT} />
          <InfoCard id="b" coordinate={B} content={{ title }} />
        </MapramaView>
      );
    }
    const { rerender, unmount } = await render(<Tree title="First" />);
    await emit(READY);
    await nextFrame();

    clearPosted();
    await rerender(<Tree title="First" />);
    await nextFrame();
    expect(commands()).toEqual([]);

    clearPosted();
    await rerender(<Tree title="Second" />);
    await nextFrame();
    expect(commandTypes()).toEqual(['setInfoCard']);
    expect(commandsOf('setInfoCard')[0]!.card.id).toBe('b');
    await unmount();
  });

  it('routes infoCard:press and infoCard:dismiss to the matching card only', async () => {
    const pressA = jest.fn();
    const pressB = jest.fn();
    const dismissA = jest.fn();
    const { unmount } = await render(
      <MapramaView world={WORLD}>
        <InfoCard id="a" coordinate={A} dismissible content={CONTENT} onPress={pressA} onDismiss={dismissA} />
        <InfoCard id="b" coordinate={B} content={{ title: 'Second' }} onPress={pressB} />
      </MapramaView>,
    );
    await emit(READY);
    await nextFrame();

    await emit({ type: 'infoCard:press', id: 'a', actionId: 'route' });
    await emit({ type: 'infoCard:press', id: 'a' });
    await emit({ type: 'infoCard:dismiss', id: 'a' });
    expect(pressA.mock.calls).toEqual([[{ id: 'a', actionId: 'route' }], [{ id: 'a' }]]);
    expect(dismissA.mock.calls).toEqual([[{ id: 'a' }]]);
    expect(pressB).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('ref.focusOn', () => {
  async function mounted() {
    const ref = createRef<MapramaViewRef>();
    const view = await render(
      <MapramaView ref={ref} world={WORLD}>
        <InfoCard id="a" coordinate={A} content={CONTENT} />
      </MapramaView>,
    );
    await emit(READY);
    await nextFrame();
    clearPosted();
    return { ref, view };
  }

  it('sends a coordinate target with the options and resolves with the engine result', async () => {
    const { ref, view } = await mounted();
    const promise = ref.current!.focusOn(A, { pitch: 55, heightMeters: 30, animate: true });
    const sent = commandsOf('request')[0]!;
    expect(sent.method).toBe('focusOn');
    expect(sent.params).toEqual({ coordinate: A, pitch: 55, heightMeters: 30, animate: true });

    const result = { camera: { center: A, distance: 180, pitch: 55, bearing: 20 }, fitted: true, distanceLimited: false };
    await emit({ type: 'response', requestId: sent.requestId, ok: true, result });
    await expect(promise).resolves.toEqual(result);
    await view.unmount();
  });

  it('sends an info-card target as infoCardId', async () => {
    const { ref, view } = await mounted();
    // The map unmounts before the engine answers, so the promise rejects: that is not what
    // this test is about.
    ref.current!.focusOn({ infoCardId: 'a' }, { inset: false }).catch(() => {});
    expect(commandsOf('request')[0]!.params).toEqual({ infoCardId: 'a', inset: false });
    await view.unmount();
  });

  it('keeps the timeout option out of the engine params', async () => {
    const { ref, view } = await mounted();
    ref.current!.focusOn(A, { timeoutMs: 1234 }).catch(() => {});
    expect(commandsOf('request')[0]!.params).toEqual({ coordinate: A });
    expect(latestWebView().posted.join('')).not.toContain('1234');
    await view.unmount();
  });
});
