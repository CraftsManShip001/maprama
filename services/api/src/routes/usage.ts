import type { Hono } from 'hono';
import { UNIT_WEIGHTS, USAGE_UNITS } from '../config.js';
import type { ServiceDeps } from '../deps.js';
import { authenticate } from '../middleware/auth.js';
import { monthKey, type AppEnv } from '../util/http.js';

export function registerUsageRoutes(app: Hono<AppEnv>, deps: ServiceDeps): void {
  app.get('/v1/usage', authenticate(deps), async (c) => {
    const key = c.get('apiKey');
    const month = monthKey(deps.clock.now());
    const lines = await deps.usage.breakdown(key.id, month);
    const byUnit = new Map(lines.map((l) => [l.unit, l]));
    const breakdown = USAGE_UNITS.map((unit) => ({
      unit,
      weight: UNIT_WEIGHTS[unit],
      requests: byUnit.get(unit)?.requests ?? 0,
      units: byUnit.get(unit)?.units ?? 0,
      overageUnits: byUnit.get(unit)?.overageUnits ?? 0,
    }));
    const usedUnits = breakdown.reduce((s, l) => s + l.units, 0);
    const overageUnits = breakdown.reduce((s, l) => s + l.overageUnits, 0);
    return c.json({
      month,
      appId: key.appId,
      plan: key.plan,
      monthlyQuota: key.monthlyQuota,
      usedUnits,
      remainingUnits: Math.max(0, key.monthlyQuota - usedUnits),
      overageUnits,
      breakdown,
    });
  });
}
