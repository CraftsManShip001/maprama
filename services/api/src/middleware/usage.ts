import type { Context, MiddlewareHandler } from 'hono';
import { UNIT_WEIGHTS } from '../config.js';
import type { ServiceDeps, UsageUnit } from '../deps.js';
import { errorBody } from '../errors.js';
import { monthKey, type AppEnv } from '../util/http.js';

function setUsageHeaders(c: Context<AppEnv>, used: number, quota: number): void {
  const headers: [string, string][] = [
    ['X-Maprama-Usage', `${used}/${quota}`],
    ['X-RateLimit-Limit', String(quota)],
    ['X-RateLimit-Remaining', String(Math.max(0, quota - used))],
  ];
  for (const [k, v] of headers) {
    try {
      c.res.headers.set(k, v);
    } catch {
      // Immutable headers (e.g. a proxied Response): rebuild the response.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set(k, v);
    }
  }
}

/** Whether a response status is billable: success, or a completed verification (422). */
export function isBillableStatus(status: number): boolean {
  return status < 400 || status === 422;
}

/**
 * Meters one request of `unit` against the key's UTC-month quota.
 * Free plan: `429 QUOTA_EXCEEDED` once the quota would be exceeded.
 * Pro plan: continues and records the units beyond quota as overage.
 *
 * The check-then-record sequence is not transactional; concurrent requests can
 * overshoot a free quota by at most the in-flight request count.
 */
export function meter(deps: ServiceDeps, unit: UsageUnit): MiddlewareHandler<AppEnv> {
  const weight = UNIT_WEIGHTS[unit];
  return async (c, next) => {
    const key = c.get('apiKey');
    const month = monthKey(deps.clock.now());
    const used = await deps.usage.monthTotal(key.id, month);
    if (key.plan === 'free' && used + weight > key.monthlyQuota) {
      const res = c.json(errorBody('QUOTA_EXCEEDED', 'Monthly free quota exceeded; upgrade the plan or wait for the next UTC month'), 429);
      c.res = res;
      setUsageHeaders(c, used, key.monthlyQuota);
      return c.res;
    }
    await next();
    if (isBillableStatus(c.res.status)) {
      const after = used + weight;
      const overageUnits = key.plan === 'pro' ? Math.max(0, Math.min(weight, after - key.monthlyQuota)) : 0;
      await deps.usage.record({ keyId: key.id, month, unit, units: weight, overageUnits });
      setUsageHeaders(c, after, key.monthlyQuota);
    } else {
      setUsageHeaders(c, used, key.monthlyQuota);
    }
  };
}
