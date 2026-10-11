import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { demoScripts, FakeMetricsProvider } from './provider.js';
import { Store } from './store.js';
import { defaultOptions, SyncService } from './sync-service.js';
import { systemClock, systemSleeper } from './types.js';

function setting(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} deve ser um inteiro não negativo.`);
  return Number(value);
}

const port = setting('PORT', 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido.');
const path = process.env.DB_PATH ?? './data/metrics.db';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const store = new Store(path);
const service = new SyncService(store, new FakeMetricsProvider(systemClock, demoScripts()),
  systemClock, systemSleeper, {
    timeoutMs: setting('TIMEOUT_MS', defaultOptions.timeoutMs),
    maxAttempts: setting('MAX_ATTEMPTS', defaultOptions.maxAttempts),
    maxWaitMs: setting('MAX_WAIT_MS', defaultOptions.maxWaitMs),
    backoffMs: setting('BACKOFF_MS', defaultOptions.backoffMs),
    maxPages: setting('MAX_PAGES', defaultOptions.maxPages),
  });
const server = serve({ fetch: createApp(service).fetch, port, hostname: '127.0.0.1' },
  () => console.log(`API simulada em http://127.0.0.1:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
