import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app.js';
import { demoScripts, FakeMetricsProvider } from '../src/provider.js';
import { Store } from '../src/store.js';
import { SyncService } from '../src/sync-service.js';
import type { Connection, SyncRun } from '../src/types.js';

export type DemoEvent = {
  label: string;
  request: { method: string; path: string; body?: unknown };
  status: number;
  response: unknown;
};

/** Executes requests against the real Hono app and a real SQLite DB in memory. */
export async function runDemo(): Promise<DemoEvent[]> {
  let now = new Date('2026-10-11T12:00:00.000Z').getTime();
  const clock = { now: () => new Date(now) };
  const sleeper = { sleep: async (ms: number) => { now += ms; } };
  const store = new Store();
  const service = new SyncService(store, new FakeMetricsProvider(clock, demoScripts()), clock, sleeper);
  const app = createApp(service);
  const events: DemoEvent[] = [];
  const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' };
  async function request<T>(label: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await app.request(path, { method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    const result: unknown = await response.json();
    events.push({ label, request: { method, path, ...(body === undefined ? {} : { body }) },
      status: response.status, response: result });
    if (response.status >= 400) throw new Error(`Demo request failed: ${label}`);
    return result as T;
  }
  const connection = (token: string) => request<Omit<Connection, 'token'>>(token, 'POST', '/connections',
    { creator_id: 'creator-demo', provider: 'instagram', token });
  try {
    const regular = await connection('fake:success');
    const success = await request<SyncRun>('success', 'POST', `/connections/${regular.id}/syncs`, window);
    await request('posts-history', 'GET', `/connections/${regular.id}/posts?history=true`);
    await request('metrics-success', 'GET', `/connections/${regular.id}/metrics`);
    await request('replay', 'POST', `/connections/${regular.id}/syncs`, window);
    await request('overlap', 'POST', `/connections/${regular.id}/syncs`, { ...window, from: '2026-10-04T00:00:00Z' });
    await request('metrics-overlap', 'GET', `/connections/${regular.id}/metrics`);
    await request('stored-run', 'GET', `/syncs/${success.id}`);
    const timeout = await connection('fake:timeout-once');
    await request('timeout-recovered', 'POST', `/connections/${timeout.id}/syncs`, window);
    const rate = await connection('fake:rate-limit');
    await request('rate-limit-recovered', 'POST', `/connections/${rate.id}/syncs`, window);
    const deferred = await connection('fake:deferred');
    await request('deferred', 'POST', `/connections/${deferred.id}/syncs`, window);
    await request('cooldown', 'POST', `/connections/${deferred.id}/syncs`, window);
    now += 60_000;
    await request('resumed', 'POST', `/connections/${deferred.id}/syncs`, window);
    return events;
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runDemo(), null, 2));
}
