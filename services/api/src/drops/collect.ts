/**
 * Server-side verification of a drop collection reported by the SDK.
 *
 * The SDK judges collection instantly on-device and forwards
 * `{dropId, collectId, userId, fix}`; this module decides whether it counts.
 */
import { haversineMeters } from '@maprama/protocol';
import { COLLECT_RULES } from '../config.js';
import type { CollectFix, CollectRecord, ServiceDeps } from '../deps.js';
import { badRequest, type ErrorCode } from '../errors.js';
import { deriveReceiptSecret } from '../util/crypto.js';
import { isLngLat } from '../util/geo.js';
import { RECEIPT_VERSION, signReceipt, type ReceiptClaims } from '../verify.js';
import { isPlainObject } from './campaign.js';
import { dropFromRef, parseDropId, windowExists, windowIndex } from './generate.js';

export interface CollectInput {
  dropId: string;
  collectId: string;
  userId: string;
  fix: CollectFix;
}

const COLLECT_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export function parseCollectInput(body: unknown): CollectInput {
  if (!isPlainObject(body)) throw badRequest('Body must be a JSON object');
  const { dropId, collectId, userId, fix } = body;
  if (typeof dropId !== 'string' || dropId.length === 0 || dropId.length > 128) throw badRequest('"dropId" must be a string');
  if (typeof collectId !== 'string' || !COLLECT_ID_RE.test(collectId)) throw badRequest('"collectId" must match ^[A-Za-z0-9_.:-]{8,128}$');
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) throw badRequest('"userId" must be a string of 1-128 characters');
  if (!isPlainObject(fix) || !isLngLat(fix)) throw badRequest('"fix" must contain valid "lng" and "lat"');
  const { accuracyMeters, timestamp } = fix;
  if (typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    throw badRequest('"fix.accuracyMeters" must be a non-negative number');
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) throw badRequest('"fix.timestamp" must be milliseconds since the Unix epoch');
  return { dropId, collectId, userId, fix: { lng: fix.lng, lat: fix.lat, accuracyMeters, timestamp } };
}

export type CollectOutcome =
  | { ok: true; replayed: boolean; record: CollectRecord; claims: ReceiptClaims | null }
  | { ok: false; status: 409 | 422; code: ErrorCode; message: string };

const reject = (code: ErrorCode, message: string, status: 409 | 422 = 422): CollectOutcome => ({ ok: false, status, code, message });

function replayOrConflict(existing: CollectRecord, input: CollectInput): CollectOutcome {
  if (existing.dropId === input.dropId && existing.userId === input.userId) {
    return { ok: true, replayed: true, record: existing, claims: null };
  }
  return reject('COLLECT_ID_CONFLICT', 'collectId was already used for a different drop or user', 409);
}

/** Verifies a collect and, on success, stores it and returns the signed receipt. */
export async function verifyCollect(deps: ServiceDeps, appId: string, input: CollectInput): Promise<CollectOutcome> {
  const now = deps.clock.now();

  const existing = await deps.drops.findCollect(appId, input.collectId);
  if (existing) return replayOrConflict(existing, input);

  const ref = parseDropId(input.dropId);
  if (!ref) return reject('DROP_NOT_FOUND', 'Unknown drop');
  const campaign = await deps.drops.getCampaign(appId, ref.campaignId);
  if (!campaign) return reject('DROP_NOT_FOUND', 'Unknown drop');

  const current = windowIndex(campaign, now);
  if (ref.window > current || !windowExists(campaign, ref.window)) return reject('DROP_NOT_FOUND', 'Unknown drop');
  if (ref.window < current - 1) return reject('DROP_EXPIRED', 'The drop window has ended');

  const drop = dropFromRef(campaign, ref);
  if (!drop) return reject('DROP_NOT_FOUND', 'Unknown drop');

  if (Math.abs(input.fix.timestamp - now) > COLLECT_RULES.maxClockSkewMs) {
    return reject('STALE_FIX', 'Fix timestamp is more than 2 minutes away from the server clock');
  }

  const distance = haversineMeters(input.fix, drop.coordinate);
  const allowed = campaign.collectRadiusMeters + Math.min(input.fix.accuracyMeters, COLLECT_RULES.maxAccuracyBonusMeters);
  if (distance > allowed) return reject('TOO_FAR', `Fix is ${Math.round(distance)} m from the drop (allowed ${Math.round(allowed)} m)`);

  if (await deps.drops.hasUserCollected(appId, input.userId, input.dropId)) {
    return reject('ALREADY_COLLECTED', 'The user has already collected this drop');
  }

  const last = await deps.drops.lastCollect(appId, input.userId);
  if (last) {
    const meters = haversineMeters(last.fix, input.fix);
    // Elapsed time comes from server verification times only. Fix timestamps are
    // client-supplied and may each be skewed by up to maxClockSkewMs, which would
    // otherwise add minutes of fake travel time.
    const dtMs = Math.max(now - last.collectedAt, COLLECT_RULES.minSpeedDeltaMs);
    const speed = meters / (dtMs / 1000);
    if (speed > COLLECT_RULES.maxSpeedMps) {
      return reject('TELEPORT', `Implied speed ${Math.round(speed)} m/s since the previous collect exceeds ${COLLECT_RULES.maxSpeedMps} m/s`);
    }
  }

  const claims: ReceiptClaims = {
    v: RECEIPT_VERSION,
    appId,
    dropId: input.dropId,
    collectId: input.collectId,
    userId: input.userId,
    payload: drop.payload ?? null,
    collectedAt: now,
    type: drop.type,
    ...(drop.rarity ? { rarity: drop.rarity } : {}),
  };
  const receipt = await signReceipt(claims, await deriveReceiptSecret(deps.secrets.receiptSecret, appId));
  const record: CollectRecord = { appId, collectId: input.collectId, dropId: input.dropId, userId: input.userId, fix: input.fix, collectedAt: now, receipt };

  const inserted = await deps.drops.insertCollect(record);
  if (inserted === 'duplicate_collect_id') {
    const raced = await deps.drops.findCollect(appId, input.collectId);
    return raced ? replayOrConflict(raced, input) : reject('COLLECT_ID_CONFLICT', 'collectId conflict', 409);
  }
  if (inserted === 'duplicate_user_drop') return reject('ALREADY_COLLECTED', 'The user has already collected this drop');
  return { ok: true, replayed: false, record, claims };
}
