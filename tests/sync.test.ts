import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeMetricsProvider, ProviderError } from '../src/provider.js';
import type { ProviderPage } from '../src/provider.js';
import { Store } from '../src/store.js';
import { SyncService } from '../src/sync-service.js';
import { ControlledTime, page, setup, snapshot, stores, window } from './helpers.js';

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  vi.useRealTimers();
});

describe('snapshot identity and aggregation', () => {
  it('replay and overlapping windows keep one snapshot; fetched_at stays the first fetch', async () => {
    const { service, store, clock, connection } = setup([page(snapshot()), page(snapshot())]);
    const first = await service.sync(connection.id, window);
    clock.advance(5000);
    const second = await service.sync(connection.id, { ...window, from: '2026-10-04T00:00:00Z' });
    expect(first.summary.snapshots_inserted).toBe(1);
    expect(second.summary).toMatchObject({ snapshots_inserted: 0, duplicates: 1, posts_observed: 1 });
    const posts = store.listPosts(connection.id, true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.history).toHaveLength(1);
    expect(posts[0]!.current).toMatchObject({ captured_at: '2026-10-05T12:00:00.000Z',
      fetched_at: first.started_at, views: 100 });
    expect(posts[0]!.last_seen_at).toBe(second.started_at);
    expect(store.metrics(connection.id)).toEqual({ posts: 1, views: 100, likes: 10, comments: 2 });
    expect(store.getRun(second.id)).toEqual(second);
  });

  it('keeps history and uses the newest measurement instead of adding cumulative counters', async () => {
    const { service, store, connection } = setup([page(snapshot()),
      page(snapshot(150, '2026-10-06T12:00:00Z')), page(snapshot(80, '2026-10-04T12:00:00Z'))]);
    await service.sync(connection.id, window);
    const update = await service.sync(connection.id, window);
    const late = await service.sync(connection.id, window);
    expect(update.summary.current_updated).toBe(1);
    expect(late.summary.current_updated).toBe(0);
    expect(store.listPosts(connection.id, true)[0]!.history).toHaveLength(3);
    expect(store.metrics(connection.id).views).toBe(150);
  });

  it('canonicalizes offsets so equivalent instants do not become distinct snapshots', async () => {
    const { service, store, connection } = setup([page(snapshot()),
      page(snapshot(100, '2026-10-05T09:00:00-03:00'))]);
    await service.sync(connection.id, window);
    expect((await service.sync(connection.id, window)).summary.duplicates).toBe(1);
    expect(store.listPosts(connection.id, true)[0]!.history).toHaveLength(1);
  });

  it('preserves the first conflicting value and stores an audit of the rejected metrics', async () => {
    const { service, store, connection } = setup([page(snapshot(), snapshot(999))]);
    const run = await service.sync(connection.id, window);
    expect(run.summary.conflicts).toEqual([{ provider_post_id: 'post-1',
      captured_at: '2026-10-05T12:00:00.000Z', original: { views: 100, likes: 10, comments: 2 },
      received: { views: 999, likes: 10, comments: 2 } }]);
    expect(run.summary.snapshots_inserted).toBe(1);
    expect(store.listPosts(connection.id, true)[0]!.history).toHaveLength(1);
    expect(store.metrics(connection.id).views).toBe(100);
    expect(store.getRun(run.id)!.summary.conflicts).toEqual(run.summary.conflicts);
  });

  it('distinct posts with equal metrics and different connections remain separate', async () => {
    const { service, store, connection } = setup([page(snapshot(), snapshot(100, undefined, 'post-2'))]);
    const other = service.createConnection({ creator_id: 'creator-2', provider: 'x', token: 'test' });
    await service.sync(connection.id, window);
    await service.sync(other.id, window);
    expect(store.metrics(connection.id)).toMatchObject({ posts: 2, views: 200 });
    expect(store.metrics(other.id)).toMatchObject({ posts: 2, views: 200 });
  });

  it('returns exact decimal totals when multiple safe counters exceed the JSON integer range', async () => {
    const { service, store, connection } = setup([page(snapshot(Number.MAX_SAFE_INTEGER),
      snapshot(Number.MAX_SAFE_INTEGER, undefined, 'post-2'))]);
    await service.sync(connection.id, window);
    expect(store.metrics(connection.id).views).toBe('18014398509481982');
  });
});

describe('retry and rate limit with a controlled clock', () => {
  it.each([1, 5, 0])('waits exactly Retry-After=%s seconds, including equality to the cap', async (seconds) => {
    const { service, fake, clock, connection } = setup([
      { type: 'rate_limit', retryAfter: String(seconds) }, page(snapshot()),
    ]);
    const run = await service.sync(connection.id, window);
    expect(run.status).toBe('succeeded');
    expect(run.attempts).toBe(2);
    expect(clock.waits).toEqual([seconds * 1000]);
    expect(new Date(fake.calls[1]!.at).getTime() - new Date(fake.calls[0]!.at).getTime()).toBe(seconds * 1000);
    expect(run.next_eligible_at).toBeNull();
  });

  it('defers above the cap, blocks a new overlapping request, and resumes exactly at eligibility', async () => {
    const { service, fake, clock, store, connection } = setup([
      { type: 'rate_limit', retryAfter: '6' }, page(snapshot()),
    ]);
    const first = await service.sync(connection.id, window);
    expect(first).toMatchObject({ status: 'deferred', attempts: 1,
      reason: 'rate_limit_wait_exceeds_cap', next_eligible_at: '2026-10-11T12:00:06.000Z' });
    expect(clock.waits).toEqual([]);
    clock.advance(5999);
    const early = await service.sync(connection.id, { ...window, from: '2026-10-02T00:00:00Z' });
    expect(early).toMatchObject({ status: 'deferred', attempts: 0, reason: 'rate_limit_cooldown' });
    expect(fake.calls).toHaveLength(1);
    expect(store.listPosts(connection.id)).toEqual([]);
    clock.advance(1);
    expect((await service.sync(connection.id, window)).status).toBe('succeeded');
    expect(fake.calls).toHaveLength(2);
  });

  it.each(['1', '5'])('does not sleep or create an extra attempt for a last-attempt 429 (%s)', async (retryAfter) => {
    const { service, fake, clock, connection } = setup([{ type: 'rate_limit', retryAfter }], { maxAttempts: 1 });
    const run = await service.sync(connection.id, window);
    expect(run).toMatchObject({ status: 'failed', attempts: 1, reason: 'rate_limit_attempts_exhausted' });
    expect(clock.waits).toEqual([]);
    expect((await service.sync(connection.id, window)).status).toBe('deferred');
    expect(fake.calls).toHaveLength(1);
  });

  it.each([null, 'bad', '-1', '0.5', 'Sun, 11 Oct 2026 12:00:01 GMT'])
    ('uses documented finite backoff for unsupported Retry-After %s', async (retryAfter) => {
      const { service, clock, connection } = setup([{ type: 'rate_limit', retryAfter }, page(snapshot())]);
      expect((await service.sync(connection.id, window)).status).toBe('succeeded');
      expect(clock.waits).toEqual([100]);
    });

  it('an unrepresentable integer Retry-After fails without retrying early', async () => {
    const { service, fake, clock, connection } = setup([
      { type: 'rate_limit', retryAfter: '999999999999999999' }, page(snapshot()),
    ]);
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 1,
      reason: 'invalid_payload' });
    expect(clock.waits).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it('repeated 429 responses each wait their requested interval until the attempt budget ends', async () => {
    const { service, fake, clock, connection } = setup([
      { type: 'rate_limit', retryAfter: '1' }, { type: 'rate_limit', retryAfter: '2' },
      { type: 'rate_limit', retryAfter: '1' },
    ]);
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(clock.waits).toEqual([1000, 2000]);
    expect(fake.calls.map((call) => call.at)).toEqual([
      '2026-10-11T12:00:00.000Z', '2026-10-11T12:00:01.000Z', '2026-10-11T12:00:03.000Z',
    ]);
  });

  it('timeout and transient failures retry successfully without losing the attempt count', async () => {
    const { service, clock, fake, connection } = setup([{ type: 'timeout' }, { type: 'transient' }, page(snapshot())]);
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(clock.waits).toEqual([100, 100]);
    expect(fake.calls.every((call) => call.timeoutMs === 1000)).toBe(true);
  });

  it('permanent timeouts stop at the attempt budget', async () => {
    const { service, clock, fake, connection } = setup([{ type: 'timeout' }, { type: 'timeout' }, { type: 'timeout' }]);
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 3,
      reason: 'timeout_attempts_exhausted' });
    expect(clock.waits).toEqual([100, 100]);
    expect(fake.calls).toHaveLength(3);
  });

  it('the service itself times out a provider that never settles and aborts its signal', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { service, connection } = setup(undefined, { timeoutMs: 25, maxAttempts: 2 }, {
      fetchPosts: async (input) => { signals.push(input.signal); return new Promise<ProviderPage>(() => {}); },
    });
    const promise = service.sync(connection.id, window);
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toMatchObject({ status: 'failed', attempts: 2, reason: 'timeout_attempts_exhausted' });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rate-limit eligibility and snapshots survive database reopening', async () => {
    const base = resolve('data');
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, 'test-persistence-'));
    const path = join(directory, 'metrics.db');
    const clock = new ControlledTime();
    let store = new Store(path);
    try {
      const fake = new FakeMetricsProvider(clock, { test: [page(snapshot()), { type: 'rate_limit', retryAfter: '6' }] });
      let service = new SyncService(store, fake, clock, clock);
      const connection = service.createConnection({ creator_id: 'creator-1', provider: 'x', token: 'test' });
      const success = await service.sync(connection.id, window);
      const deferred = await service.sync(connection.id, window);
      store.close();
      store = new Store(path);
      const secondFake = new FakeMetricsProvider(clock);
      service = new SyncService(store, secondFake, clock, clock);
      expect(store.getRun(success.id)).toEqual(success);
      expect(store.getRun(deferred.id)).toEqual(deferred);
      expect(store.metrics(connection.id).views).toBe(100);
      expect((await service.sync(connection.id, window)).status).toBe('deferred');
      expect(secondFake.calls).toHaveLength(0);
    } finally {
      store.close();
      if (!directory.startsWith(base + '\\') && !directory.startsWith(base + '/')) throw new Error('Unexpected test directory');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('pagination, isolation and invalid inputs', () => {
  it('a post repeated on the next page is persisted once, with retry budget per page', async () => {
    const { service, store, fake, connection } = setup([
      { type: 'page', page: { posts: [snapshot()], nextCursor: 'page-2' } },
      { type: 'timeout' }, page(snapshot(), snapshot(200, undefined, 'post-2')),
    ], { maxAttempts: 2 });
    const run = await service.sync(connection.id, window);
    expect(run).toMatchObject({ status: 'succeeded', attempts: 3,
      summary: { pages: 2, posts_observed: 2, snapshots_inserted: 2, duplicates: 1 } });
    expect(fake.calls.map((call) => call.cursor)).toEqual([null, 'page-2', 'page-2']);
    expect(store.metrics(connection.id).views).toBe(300);
  });

  it('cyclic pagination is a finite failure and prior pages remain observable', async () => {
    const step = { type: 'page' as const, page: { posts: [snapshot()], nextCursor: 'same' } };
    const { service, store, fake, connection } = setup([step, step]);
    const run = await service.sync(connection.id, window);
    expect(run).toMatchObject({ status: 'failed', attempts: 2, reason: 'pagination_cycle', summary: { pages: 1 } });
    expect(fake.calls).toHaveLength(2);
    expect(store.metrics(connection.id).views).toBe(100);
  });

  it('ever-changing cursors cannot bypass the page limit', async () => {
    const { service, fake, connection } = setup([
      { type: 'page', page: { posts: [snapshot()], nextCursor: 'a' } },
      { type: 'page', page: { posts: [snapshot()], nextCursor: 'b' } },
    ], { maxPages: 2 });
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 2,
      reason: 'page_limit_exhausted' });
    expect(fake.calls).toHaveLength(2);
  });

  it('failure on a later page records the already committed partial result', async () => {
    const { service, store, connection } = setup([
      { type: 'page', page: { posts: [snapshot()], nextCursor: 'a' } }, { type: 'timeout' },
    ], { maxAttempts: 1 });
    const run = await service.sync(connection.id, window);
    expect(run).toMatchObject({ status: 'failed', summary: { pages: 1, snapshots_inserted: 1 } });
    expect(store.getRun(run.id)).toEqual(run);
    expect(store.metrics(connection.id).views).toBe(100);
  });

  it.each([
    { ...window, from: window.to }, { ...window, from: '2026-10-12T00:00:00Z' },
    { ...window, from: '2026-02-30T00:00:00Z' }, { ...window, from: '2026-10-01' },
    { ...window, from: '2026-10-01T24:00:00Z' },
  ])('rejects an invalid window before calling the provider: %j', async (input) => {
    const { service, fake, connection } = setup();
    await expect(service.sync(connection.id, input)).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    snapshot(-1), snapshot(0.5), snapshot(Number.MAX_SAFE_INTEGER + 1),
    snapshot(100, '2026-10-12T12:00:00Z'), snapshot(100, 'bad'),
    { ...snapshot(), providerPostId: '' },
  ])('rejects a bad page atomically and does not retry permanent invalid payloads: %j', async (invalid) => {
    const { service, store, fake, connection } = setup([page(snapshot(100, undefined, 'valid'), invalid)]);
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 1,
      reason: 'invalid_payload', summary: { pages: 0, snapshots_inserted: 0 } });
    expect(store.metrics(connection.id).posts).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it.each(['2026-09-30T23:59:59.999Z', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00.001Z'])
    ('rejects a snapshot outside the semi-open capture window: %s', async (capturedAt) => {
      const { service, store, connection } = setup([page(snapshot(), snapshot(7, capturedAt, 'outside'))]);
      expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 1,
        reason: 'invalid_payload', summary: { snapshots_inserted: 0 } });
      expect(store.listPosts(connection.id)).toEqual([]);
    });

  it('accepts captures exactly at from and at the last millisecond before to', async () => {
    const { service, store, connection } = setup([page(snapshot(7, window.from, 'first'),
      snapshot(9, '2026-10-09T23:59:59.999Z', 'last'))]);
    expect((await service.sync(connection.id, window)).status).toBe('succeeded');
    expect(store.metrics(connection.id).views).toBe(16);
  });

  it('a concurrent request is rejected; the connection becomes available after completion', async () => {
    let resolvePage!: (page: ProviderPage) => void;
    const { service, connection } = setup(undefined, {}, {
      fetchPosts: async () => new Promise<ProviderPage>((resolve) => { resolvePage = resolve; }),
    });
    const first = service.sync(connection.id, window);
    await expect(service.sync(connection.id, window)).rejects.toMatchObject({ status: 409 });
    resolvePage({ posts: [snapshot()], nextCursor: null });
    expect((await first).status).toBe('succeeded');
    const second = service.sync(connection.id, window);
    resolvePage({ posts: [snapshot()], nextCursor: null });
    expect((await second).summary.duplicates).toBe(1);
  });

  it('an unexpected provider failure is reported without exposing the error or a token', async () => {
    const { service, connection } = setup(undefined, {}, {
      fetchPosts: async () => { throw new Error('sensitive-token'); },
    });
    const run = await service.sync(connection.id, window);
    expect(run).toMatchObject({ status: 'failed', attempts: 1, reason: 'provider_error' });
    expect(JSON.stringify(run)).not.toContain('sensitive-token');
  });

  it('a permanently invalid provider response has no retry', async () => {
    const { service, connection } = setup(undefined, {}, {
      fetchPosts: async () => { throw new ProviderError('invalid_payload'); },
    });
    expect(await service.sync(connection.id, window)).toMatchObject({ status: 'failed', attempts: 1 });
  });
});
