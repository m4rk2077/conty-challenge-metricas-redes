import { FakeMetricsProvider } from '../src/provider.js';
import type { FakeStep, MetricsProvider, ProviderPostSnapshot } from '../src/provider.js';
import { Store } from '../src/store.js';
import { SyncService } from '../src/sync-service.js';
import type { SyncOptions } from '../src/sync-service.js';
import type { Clock, Sleeper } from '../src/types.js';

export class ControlledTime implements Clock, Sleeper {
  private time = new Date('2026-10-11T12:00:00.000Z').getTime();
  readonly waits: number[] = [];
  now(): Date { return new Date(this.time); }
  advance(ms: number): void { this.time += ms; }
  async sleep(ms: number): Promise<void> { this.waits.push(ms); this.advance(ms); }
}
export const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' };
export function snapshot(views = 100, capturedAt = '2026-10-05T12:00:00Z', providerPostId = 'post-1'): ProviderPostSnapshot {
  return { providerPostId, capturedAt, metrics: { views, likes: 10, comments: 2 } };
}
export function page(...posts: ProviderPostSnapshot[]): FakeStep {
  return { type: 'page', page: { posts, nextCursor: null } };
}
export const stores = new Set<Store>();
export function setup(steps?: FakeStep[], options: Partial<SyncOptions> = {}, customProvider?: MetricsProvider) {
  const clock = new ControlledTime();
  const store = new Store();
  stores.add(store);
  const fake = new FakeMetricsProvider(clock, steps ? { test: steps } : {});
  const service = new SyncService(store, customProvider ?? fake, clock, clock, options);
  const connection = service.createConnection({ creator_id: 'creator-1', provider: 'instagram', token: 'test' });
  return { store, clock, fake, service, connection };
}
