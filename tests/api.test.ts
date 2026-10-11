import { afterEach, describe, expect, it } from 'vitest';
import { runDemo } from '../examples/demo.js';
import { createApp } from '../src/app.js';
import type { SyncRun } from '../src/types.js';
import { page, setup, snapshot, stores, window } from './helpers.js';

afterEach(() => { for (const store of stores) store.close(); stores.clear(); });

describe('API contract', () => {
  it('creates an authorized connection, runs a sync, exposes posts/history and saved audit', async () => {
    const { service } = setup([page(snapshot())]);
    const app = createApp(service);
    const created = await app.request('/connections', { method: 'POST',
      body: JSON.stringify({ creator_id: 'creator-api', provider: 'youtube', token: 'test' }),
      headers: { 'content-type': 'application/json' } });
    expect(created.status).toBe(201);
    const connection = await created.json() as { id: string; creator_id: string };
    expect(connection.creator_id).toBe('creator-api');
    expect(connection).not.toHaveProperty('token');
    const response = await app.request(`/connections/${connection.id}/syncs`, {
      method: 'POST', body: JSON.stringify(window), headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(201);
    const run = await response.json() as SyncRun;
    expect(run).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await (await app.request(`/syncs/${run.id}`)).json()).toEqual(run);
    const posts = await (await app.request(`/connections/${connection.id}/posts?history=true`)).json();
    expect(posts).toMatchObject({ posts: [{ provider_post_id: 'post-1', current: {
      captured_at: '2026-10-05T12:00:00.000Z', fetched_at: '2026-10-11T12:00:00.000Z', views: 100,
    }, history: [{ views: 100 }] }] });
    expect(await (await app.request(`/connections/${connection.id}/metrics`)).json())
      .toEqual({ posts: 1, views: 100, likes: 10, comments: 2 });
  });

  it('reports invalid JSON and missing required connection fields as 400', async () => {
    const { service } = setup();
    const app = createApp(service);
    for (const body of ['{', '{}', 'null', '[]', JSON.stringify({ creator_id: 'x', provider: 'other', token: 'test' })]) {
      const response = await app.request('/connections', { method: 'POST', body });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }
  });

  it('bad windows are rejected before provider calls; unknown ids return 404', async () => {
    const { service, fake, connection } = setup();
    const app = createApp(service);
    const invalid = await app.request(`/connections/${connection.id}/syncs`, { method: 'POST',
      body: JSON.stringify({ ...window, from: window.to }) });
    expect(invalid.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    for (const route of ['/connections/absent/posts', '/connections/absent/metrics', '/syncs/absent', '/missing']) {
      expect((await app.request(route)).status).toBe(404);
    }
    expect((await app.request('/connections/absent/syncs', { method: 'POST', body: JSON.stringify(window) })).status).toBe(404);
  });

  it('empty metrics are explicit and malformed history options are rejected', async () => {
    const { service, connection } = setup();
    const app = createApp(service);
    expect(await (await app.request(`/connections/${connection.id}/metrics`)).json())
      .toEqual({ posts: 0, views: 0, likes: 0, comments: 0 });
    expect((await app.request(`/connections/${connection.id}/posts?history=maybe`)).status).toBe(400);
  });

  it('runs the documented demo through real API requests with a controlled clock', async () => {
    const events = await runDemo();
    const result = (label: string) => events.find((event) => event.label === label)!.response;
    expect(result('metrics-success')).toEqual({ posts: 2, views: 300, likes: 30, comments: 6 });
    expect(result('replay')).toMatchObject({ status: 'succeeded', summary: { snapshots_inserted: 0, duplicates: 2 } });
    expect(result('overlap')).toMatchObject({ status: 'succeeded', summary: { snapshots_inserted: 0, duplicates: 1 } });
    expect(result('metrics-overlap')).toEqual(result('metrics-success'));
    expect(result('timeout-recovered')).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(result('rate-limit-recovered')).toMatchObject({ status: 'succeeded', attempts: 2,
      started_at: '2026-10-11T12:00:00.100Z', finished_at: '2026-10-11T12:00:01.100Z' });
    expect(result('deferred')).toMatchObject({ status: 'deferred', attempts: 1,
      next_eligible_at: '2026-10-11T12:01:01.100Z' });
    expect(result('cooldown')).toMatchObject({ status: 'deferred', attempts: 0 });
    expect(result('resumed')).toMatchObject({ status: 'succeeded', attempts: 1 });
  });
});
