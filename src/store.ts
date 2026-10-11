import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderPostSnapshot } from './provider.js';
import type { Connection, Metrics, Network, Post, Snapshot, SyncRun } from './types.js';

type RunRow = Omit<SyncRun, 'summary'> & { summary_json: string };

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, provider TEXT NOT NULL,
        token TEXT NOT NULL, created_at TEXT NOT NULL, next_eligible_at TEXT
      );
      CREATE TABLE IF NOT EXISTS posts (
        connection_id TEXT NOT NULL REFERENCES connections(id),
        provider_post_id TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, provider_post_id)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_post_id TEXT NOT NULL,
        captured_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
        views INTEGER NOT NULL CHECK(views >= 0),
        likes INTEGER NOT NULL CHECK(likes >= 0),
        comments INTEGER NOT NULL CHECK(comments >= 0),
        UNIQUE (connection_id, provider_post_id, captured_at),
        FOREIGN KEY (connection_id, provider_post_id) REFERENCES posts(connection_id, provider_post_id)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
        window_from TEXT NOT NULL, window_to TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','deferred')),
        attempts INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        next_eligible_at TEXT, reason TEXT, summary_json TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  createConnection(creatorId: string, provider: Network, token: string, now: string): Connection {
    const connection: Connection = { id: randomUUID(), creator_id: creatorId, provider,
      token, created_at: now, next_eligible_at: null };
    this.db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?, ?, NULL)')
      .run(connection.id, creatorId, provider, token, now);
    return connection;
  }

  getConnection(id: string): Connection | undefined {
    return this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Connection | undefined;
  }

  setCooldown(id: string, at: string | null): void {
    this.db.prepare('UPDATE connections SET next_eligible_at = ? WHERE id = ?').run(at, id);
  }

  createRun(connectionId: string, from: string, to: string, now: string): SyncRun {
    const run: SyncRun = { id: randomUUID(), connection_id: connectionId,
      window_from: from, window_to: to, status: 'running', attempts: 0,
      started_at: now, finished_at: null, next_eligible_at: null, reason: null,
      summary: { pages: 0, posts_observed: 0, snapshots_inserted: 0,
        current_updated: 0, duplicates: 0, conflicts: [] } };
    this.db.prepare('INSERT INTO sync_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, connectionId, from, to, run.status, 0, now, null, null, null,
        JSON.stringify(run.summary));
    return run;
  }

  saveRun(run: SyncRun): void {
    this.db.prepare(`UPDATE sync_runs SET status = ?, attempts = ?, finished_at = ?,
      next_eligible_at = ?, reason = ?, summary_json = ? WHERE id = ?`)
      .run(run.status, run.attempts, run.finished_at, run.next_eligible_at, run.reason,
        JSON.stringify(run.summary), run.id);
  }

  getRun(id: string): SyncRun | undefined {
    const row = this.db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return undefined;
    const { summary_json, ...run } = row;
    return { ...run, summary: JSON.parse(summary_json) as SyncRun['summary'] };
  }

  // All validation happens before entering this page transaction. No await while it is open.
  persistPage(run: SyncRun, posts: readonly ProviderPostSnapshot[], fetchedAt: string): void {
    const previousSummary = structuredClone(run.summary);
    this.db.exec('BEGIN');
    try {
      for (const post of posts) {
        const latest = this.db.prepare(`SELECT * FROM snapshots
          WHERE connection_id = ? AND provider_post_id = ? ORDER BY captured_at DESC LIMIT 1`)
          .get(run.connection_id, post.providerPostId) as Snapshot | undefined;
        this.db.prepare(`INSERT INTO posts VALUES (?, ?, ?, ?)
          ON CONFLICT(connection_id, provider_post_id) DO UPDATE SET
            last_seen_at = MAX(posts.last_seen_at, excluded.last_seen_at)`)
          .run(run.connection_id, post.providerPostId, fetchedAt, fetchedAt);
        const existing = this.db.prepare(`SELECT * FROM snapshots
          WHERE connection_id = ? AND provider_post_id = ? AND captured_at = ?`)
          .get(run.connection_id, post.providerPostId, post.capturedAt) as Snapshot | undefined;
        if (existing) {
          const original: Metrics = { views: existing.views, likes: existing.likes, comments: existing.comments };
          if (original.views === post.metrics.views && original.likes === post.metrics.likes &&
              original.comments === post.metrics.comments) {
            run.summary.duplicates += 1;
          } else {
            run.summary.conflicts.push({ provider_post_id: post.providerPostId,
              captured_at: post.capturedAt, original, received: post.metrics });
          }
        } else {
          this.db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), run.connection_id, post.providerPostId, post.capturedAt, fetchedAt,
              post.metrics.views, post.metrics.likes, post.metrics.comments);
          run.summary.snapshots_inserted += 1;
          if (latest && post.capturedAt > latest.captured_at) run.summary.current_updated += 1;
        }
      }
      run.summary.pages += 1;
      this.saveRun(run);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      run.summary = previousSummary;
      throw error;
    }
  }

  listPosts(connectionId: string, history = false): Post[] {
    const rows = this.db.prepare('SELECT * FROM posts WHERE connection_id = ? ORDER BY provider_post_id')
      .all(connectionId) as Omit<Post, 'current' | 'history'>[];
    const snapshots = this.db.prepare(`SELECT * FROM snapshots WHERE connection_id = ?
      ORDER BY provider_post_id, captured_at DESC`).all(connectionId) as Snapshot[];
    const byPost = new Map<string, Snapshot[]>();
    for (const snapshot of snapshots) {
      const group = byPost.get(snapshot.provider_post_id) ?? [];
      group.push(snapshot);
      byPost.set(snapshot.provider_post_id, group);
    }
    return rows.map((row) => {
      const group = byPost.get(row.provider_post_id)!;
      return { ...row, current: group[0]!, ...(history ? { history: group } : {}) };
    });
  }

  metrics(connectionId: string): {
    posts: number; views: number | string; likes: number | string; comments: number | string;
  } {
    const posts = this.listPosts(connectionId);
    const total = (key: keyof Metrics): number | string => {
      const value = posts.reduce((sum, post) => sum + BigInt(post.current[key]), 0n);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    };
    return { posts: posts.length, views: total('views'), likes: total('likes'), comments: total('comments') };
  }
}
