/**
 * Usage: tsx scripts/create-key.ts --app <appId> [--plan free|pro] [--role client|server|admin] [--quota <units>] [--label <text>]
 *
 * Prints a new raw API key (shown once; store it in your secret manager) and
 * the SQL that inserts only its SHA-256 hash:
 *   wrangler d1 execute DB --local --command "<printed SQL>"
 */
import { PLAN_DEFAULT_QUOTA } from '../src/config.js';
import type { ApiKeyRecord, Plan, Role } from '../src/deps.js';
import { inlineSql, apiKeyInsert } from '../src/adapters/d1/statements.js';
import { generateApiKey, randomHex } from '../src/util/crypto.js';

export async function createKey(input: { appId: string; plan: Plan; role: Role; quota?: number; label?: string; now?: number }): Promise<{
  key: string;
  record: ApiKeyRecord;
  sql: string;
}> {
  const { key, keyHash } = await generateApiKey(globalThis.crypto);
  const record: ApiKeyRecord = {
    id: `key_${randomHex(globalThis.crypto, 8)}`,
    keyHash,
    appId: input.appId,
    plan: input.plan,
    monthlyQuota: input.quota ?? PLAN_DEFAULT_QUOTA[input.plan],
    role: input.role,
    label: input.label ?? null,
    createdAt: input.now ?? Date.now(),
    revokedAt: null,
  };
  return { key, record, sql: inlineSql(apiKeyInsert(record)) };
}

async function main(argv: string[]): Promise<void> {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const appId = opt('--app');
  const plan = (opt('--plan') ?? 'free') as Plan;
  const role = (opt('--role') ?? 'client') as Role;
  const quotaRaw = opt('--quota');
  const label = opt('--label');
  if (!appId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(appId) || !['free', 'pro'].includes(plan) || !['client', 'server', 'admin'].includes(role)) {
    console.error('Usage: create-key --app <appId> [--plan free|pro] [--role client|server|admin] [--quota <units>] [--label <text>]');
    process.exit(2);
  }
  const quota = quotaRaw === undefined ? undefined : Number(quotaRaw);
  if (quota !== undefined && !(Number.isInteger(quota) && quota >= 0)) {
    console.error('--quota must be a non-negative integer');
    process.exit(2);
  }
  const { key, record, sql } = await createKey({ appId, plan, role, ...(quota !== undefined ? { quota } : {}), ...(label ? { label } : {}) });
  console.log(`API key (shown once): ${key}`);
  console.log(`key id: ${record.id}  app: ${record.appId}  plan: ${record.plan}  role: ${record.role}  quota: ${record.monthlyQuota}`);
  console.log(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) void main(process.argv.slice(2));
