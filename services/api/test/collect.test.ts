import { haversineMeters, type DropSpec, type LngLat } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { deriveReceiptSecret } from '../src/util/crypto.js';
import { verifyReceipt, verifyWebhookSignature } from '../src/verify.js';
import { GANGNAM, RECEIPT_SECRET, SEONGSU, createCampaign, createHarness, json, nearby, north, type Harness } from './helpers/harness.js';

type CollectJson = { receipt: string; replayed: boolean; collect: { dropId: string; collectId: string; userId: string; collectedAt: number } };
type ErrorJson = { error: { code: string; message: string } };

let seq = 0;
const newCollectId = () => `collect-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

async function setup(): Promise<{ h: Harness; admin: string; client: string; drops: DropSpec[] }> {
  const h = createHarness();
  const admin = await h.addKey({ role: 'admin' });
  const client = await h.addKey({ role: 'client' });
  await createCampaign(h, admin);
  const drops = await nearby(h, client, SEONGSU, 800);
  expect(drops.length).toBeGreaterThan(10);
  return { h, admin, client, drops };
}

function collect(h: Harness, key: string, drop: DropSpec | string, opts: { at?: LngLat; accuracy?: number; ts?: number; userId?: string; collectId?: string } = {}) {
  const dropId = typeof drop === 'string' ? drop : drop.id;
  const at = opts.at ?? (typeof drop === 'string' ? SEONGSU : drop.coordinate);
  return h.request('/v1/drops/collect', {
    key,
    method: 'POST',
    body: {
      dropId,
      collectId: opts.collectId ?? newCollectId(),
      userId: opts.userId ?? 'user-1',
      fix: { lng: at.lng, lat: at.lat, accuracyMeters: opts.accuracy ?? 5, timestamp: opts.ts ?? h.clock.now() },
    },
  });
}

describe('POST /v1/drops/collect', () => {
  it('verifies a valid collect and returns a signed receipt', async () => {
    const { h, client, drops } = await setup();
    const drop = drops[0]!;
    const res = await collect(h, client, drop, { userId: 'alice' });
    expect(res.status).toBe(200);
    const body = await json<CollectJson>(res);
    expect(body.replayed).toBe(false);
    expect(body.collect).toMatchObject({ dropId: drop.id, userId: 'alice', collectedAt: h.clock.now() });

    const verified = await verifyReceipt(body.receipt, await deriveReceiptSecret(RECEIPT_SECRET, 'app1'));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({ v: 1, appId: 'app1', dropId: drop.id, userId: 'alice', payload: drop.payload, collectedAt: h.clock.now(), type: 'coin' });
    // Another app's secret must not verify it.
    expect((await verifyReceipt(body.receipt, await deriveReceiptSecret(RECEIPT_SECRET, 'app2'))).ok).toBe(false);
  });

  it('rejects TOO_FAR, crediting accuracy up to 30 m', async () => {
    const { h, client, drops } = await setup();
    // collectRadiusMeters = 20
    const far = await collect(h, client, drops[0]!, { at: north(drops[0]!.coordinate, 55), accuracy: 100 });
    expect(far.status).toBe(422);
    expect((await json<ErrorJson>(far)).error.code).toBe('TOO_FAR');
    const lowAccuracyCredit = await collect(h, client, drops[0]!, { at: north(drops[0]!.coordinate, 45), accuracy: 5 });
    expect((await json<ErrorJson>(lowAccuracyCredit)).error.code).toBe('TOO_FAR');
    const ok = await collect(h, client, drops[0]!, { at: north(drops[0]!.coordinate, 45), accuracy: 100 });
    expect(ok.status).toBe(200);
  });

  it('rejects STALE_FIX more than 2 minutes from the server clock', async () => {
    const { h, client, drops } = await setup();
    for (const ts of [h.clock.now() - 121_000, h.clock.now() + 121_000]) {
      const res = await collect(h, client, drops[0]!, { ts });
      expect(res.status).toBe(422);
      expect((await json<ErrorJson>(res)).error.code).toBe('STALE_FIX');
    }
    expect((await collect(h, client, drops[0]!, { ts: h.clock.now() - 100_000 })).status).toBe(200);
  });

  it('replays a reused collectId with the same receipt and rejects conflicting reuse', async () => {
    const { h, client, drops } = await setup();
    const collectId = newCollectId();
    const first = await json<CollectJson>(await collect(h, client, drops[0]!, { collectId }));
    h.clock.advance(5_000);
    const secondRes = await collect(h, client, drops[0]!, { collectId });
    expect(secondRes.status).toBe(200);
    const second = await json<CollectJson>(secondRes);
    expect(second.receipt).toBe(first.receipt);
    expect(second.replayed).toBe(true);

    const conflict = await collect(h, client, drops[1]!, { collectId });
    expect(conflict.status).toBe(409);
    expect((await json<ErrorJson>(conflict)).error.code).toBe('COLLECT_ID_CONFLICT');
  });

  it('rejects ALREADY_COLLECTED for the same user and drop with a new collectId', async () => {
    const { h, client, drops } = await setup();
    expect((await collect(h, client, drops[0]!, { userId: 'bob' })).status).toBe(200);
    const again = await collect(h, client, drops[0]!, { userId: 'bob' });
    expect(again.status).toBe(422);
    expect((await json<ErrorJson>(again)).error.code).toBe('ALREADY_COLLECTED');
    expect((await collect(h, client, drops[0]!, { userId: 'carol' })).status).toBe(200);
  });

  it('rejects TELEPORT when the implied speed since the last collect exceeds 90 m/s', async () => {
    const h = createHarness();
    const admin = await h.addKey({ role: 'admin' });
    const client = await h.addKey();
    await createCampaign(h, admin, { windowMinutes: 60 });
    await createCampaign(h, admin, { channel: 'gangnam', area: { center: GANGNAM, radiusMeters: 800 }, windowMinutes: 60 });
    const seongsu = (await nearby(h, client, SEONGSU))[0]!;
    const gangnam = (await nearby(h, client, GANGNAM, 500, 'gangnam'))[0]!;

    expect((await collect(h, client, seongsu, { userId: 'dave' })).status).toBe(200);
    h.clock.advance(10_000);
    const jump = await collect(h, client, gangnam, { userId: 'dave' });
    expect(jump.status).toBe(422);
    expect((await json<ErrorJson>(jump)).error.code).toBe('TELEPORT');

    // ~5.5 km in 5 minutes (~18 m/s, a subway ride) is fine.
    h.clock.advance(290_000);
    expect((await collect(h, client, gangnam, { userId: 'dave' })).status).toBe(200);
  });

  describe('TELEPORT uses server verification times, not client fix timestamps', () => {
    async function twoCities() {
      const h = createHarness();
      const admin = await h.addKey({ role: 'admin' });
      const client = await h.addKey();
      await createCampaign(h, admin, { windowMinutes: 60 });
      await createCampaign(h, admin, { channel: 'gangnam', area: { center: GANGNAM, radiusMeters: 800 }, windowMinutes: 60 });
      const seongsu = (await nearby(h, client, SEONGSU))[0]!;
      const gangnam = (await nearby(h, client, GANGNAM, 500, 'gangnam'))[0]!;
      return { h, client, seongsu, gangnam };
    }

    it('rejects a jump 1 s apart even when fix timestamps are skewed by -119 s / +119 s', async () => {
      const { h, client, seongsu, gangnam } = await twoCities();
      // ~5.5 km apart: with the 238 s of fake fix-time gap this would be ~23 m/s.
      expect(haversineMeters(seongsu.coordinate, gangnam.coordinate)).toBeGreaterThan(3_000);
      const firstId = newCollectId();
      const first = await collect(h, client, seongsu, { userId: 'mallory', collectId: firstId, ts: h.clock.now() - 119_000 });
      expect(first.status).toBe(200);
      const firstBody = await json<CollectJson>(first);

      h.clock.advance(1_000);
      const jump = await collect(h, client, gangnam, { userId: 'mallory', ts: h.clock.now() + 119_000 });
      expect(jump.status).toBe(422);
      expect((await json<ErrorJson>(jump)).error.code).toBe('TELEPORT');

      // Replaying the first collectId still returns the original receipt.
      h.clock.advance(1_000);
      const replay = await collect(h, client, seongsu, { userId: 'mallory', collectId: firstId, ts: h.clock.now() });
      expect(replay.status).toBe(200);
      const replayBody = await json<CollectJson>(replay);
      expect(replayBody.replayed).toBe(true);
      expect(replayBody.receipt).toBe(firstBody.receipt);
    });

    it('does not reject a legitimate trip because of honest fix-timestamp skew', async () => {
      const { h, client, seongsu, gangnam } = await twoCities();
      expect((await collect(h, client, seongsu, { userId: 'trent', ts: h.clock.now() + 119_000 })).status).toBe(200);
      // 290 s of server time (~19 m/s), although the fix timestamps are only 52 s apart.
      h.clock.advance(290_000);
      expect((await collect(h, client, gangnam, { userId: 'trent', ts: h.clock.now() - 119_000 })).status).toBe(200);
    });

    it('accepts a walk between nearby drops with honest timestamps', async () => {
      const { h, client, seongsu } = await twoCities();
      const drops = await nearby(h, client, SEONGSU, 800);
      const next = drops
        .filter((d) => d.id !== seongsu.id)
        .map((d) => ({ d, meters: haversineMeters(seongsu.coordinate, d.coordinate) }))
        .sort((a, b) => a.meters - b.meters)[0]!;
      expect((await collect(h, client, seongsu, { userId: 'walter' })).status).toBe(200);
      // Walking pace, 1.5 m/s.
      h.clock.advance(Math.ceil((next.meters / 1.5) * 1000) + 1_000);
      expect((await collect(h, client, next.d, { userId: 'walter' })).status).toBe(200);
    });
  });

  it('accepts the previous window, rejects older windows as DROP_EXPIRED', async () => {
    const { h, client, drops } = await setup();
    h.clock.advance(10 * 60_000);
    expect((await collect(h, client, drops[0]!, { userId: 'erin' })).status).toBe(200);
    h.clock.advance(10 * 60_000);
    const old = await collect(h, client, drops[1]!, { userId: 'erin2' });
    expect(old.status).toBe(422);
    expect((await json<ErrorJson>(old)).error.code).toBe('DROP_EXPIRED');
  });

  it('rejects unknown, forged, future and other-app drops as DROP_NOT_FOUND', async () => {
    const { h, client, drops } = await setup();
    const [prefix, campaignId, w, cell] = drops[0]!.id.split('.');
    const otherApp = await h.addKey({ appId: 'app2' });
    for (const [key, id] of [
      [client, 'garbage'],
      [client, `${prefix}.cmp0000000000000000.${w}.${cell}.0`],
      [client, `${prefix}.${campaignId}.${w}.${cell}.99999`],
      [client, `${prefix}.${campaignId}.${Number(w) + 1}.${cell}.0`],
      [otherApp, drops[0]!.id],
    ] as const) {
      const res = await collect(h, key, id);
      expect(res.status, id).toBe(422);
      expect((await json<ErrorJson>(res)).error.code).toBe('DROP_NOT_FOUND');
    }
  });

  it('validates the body', async () => {
    const { h, client, drops } = await setup();
    const base = { dropId: drops[0]!.id, collectId: newCollectId(), userId: 'u', fix: { lng: 127, lat: 37, accuracyMeters: 5, timestamp: h.clock.now() } };
    for (const bad of [{ ...base, collectId: 'short' }, { ...base, userId: '' }, { ...base, fix: { lng: 127, lat: 37, timestamp: 1 } }, { ...base, fix: { lng: 999, lat: 37, accuracyMeters: 1, timestamp: 1 } }]) {
      expect((await h.request('/v1/drops/collect', { key: client, method: 'POST', body: bad })).status).toBe(400);
    }
  });

  it('enqueues a signed drop.collected webhook once per verified collect', async () => {
    const { h, admin, client, drops } = await setup();
    const hook = await json<{ secret: string; receiptSecret: string }>(
      await h.request('/v1/webhooks', { key: admin, method: 'POST', body: { url: 'https://app.example/maprama' } }),
    );
    const collectId = newCollectId();
    const body = await json<CollectJson>(await collect(h, client, drops[0]!, { collectId, userId: 'frank' }));
    await collect(h, client, drops[0]!, { collectId, userId: 'frank' }); // replay: no new webhook
    await h.flush();

    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0]!;
    expect(call.url).toBe('https://app.example/maprama');
    const sig = await verifyWebhookSignature(call.body, call.headers.get('Maprama-Signature'), hook.secret, 300, h.clock.now() / 1000);
    expect(sig.ok).toBe(true);
    const event = JSON.parse(call.body) as { type: string; data: { receipt: string; userId: string; dropId: string } };
    expect(event.type).toBe('drop.collected');
    expect(event.data).toMatchObject({ receipt: body.receipt, userId: 'frank', dropId: drops[0]!.id });
    expect((await verifyReceipt(event.data.receipt, hook.receiptSecret)).ok).toBe(true);
    expect(await h.deps.webhooks.listAttempts('app1')).toHaveLength(1);
  });
});
