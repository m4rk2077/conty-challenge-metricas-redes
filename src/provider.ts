import type { Clock, Metrics } from './types.js';

export type ProviderPostSnapshot = {
  providerPostId: string;
  capturedAt: string;
  metrics: Metrics;
};
export type ProviderPage = { posts: ProviderPostSnapshot[]; nextCursor: string | null };
export type FetchInput = {
  connectionId: string;
  token: string;
  from: string;
  to: string;
  cursor: string | null;
  timeoutMs: number;
  signal: AbortSignal;
};
export interface MetricsProvider { fetchPosts(input: FetchInput): Promise<ProviderPage> }

export class ProviderError extends Error {
  constructor(public readonly kind: 'timeout' | 'transient' | 'rate_limit' | 'invalid_payload',
    public readonly retryAfterMs: number | null = null) {
    super(kind);
  }
}

// Header parsing belongs to the adapter. The domain only receives a duration.
export function parseRetryAfter(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  const milliseconds = Number(header.trim()) * 1000;
  // Values beyond the Date range cannot yield a truthful next_eligible_at.
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_000_000_000_000_000) {
    // Never turn a syntactically valid but unrepresentable duration into an early retry.
    throw new ProviderError('invalid_payload');
  }
  return milliseconds;
}

export type FakeStep =
  | { type: 'page'; page: ProviderPage }
  | { type: 'timeout' }
  | { type: 'transient' }
  | { type: 'rate_limit'; retryAfter: string | null };

export const demoPosts: ProviderPostSnapshot[] = [
  { providerPostId: 'post-1', capturedAt: '2026-10-01T12:00:00.000Z',
    metrics: { views: 100, likes: 10, comments: 2 } },
  { providerPostId: 'post-2', capturedAt: '2026-10-05T12:00:00.000Z',
    metrics: { views: 200, likes: 20, comments: 4 } },
];

/** Stateful scripts are isolated by connection, even when two tokens are equal. */
export class FakeMetricsProvider implements MetricsProvider {
  readonly calls: (Omit<FetchInput, 'signal' | 'token'> & { at: string })[] = [];
  private readonly positions = new Map<string, number>();

  constructor(private readonly clock: Clock,
    private readonly scripts: Readonly<Record<string, readonly FakeStep[]>> = {},
    private readonly dataset: readonly ProviderPostSnapshot[] = demoPosts) {}

  async fetchPosts(input: FetchInput): Promise<ProviderPage> {
    this.calls.push({ connectionId: input.connectionId, from: input.from, to: input.to,
      cursor: input.cursor, timeoutMs: input.timeoutMs, at: this.clock.now().toISOString() });
    const index = this.positions.get(input.connectionId) ?? 0;
    this.positions.set(input.connectionId, index + 1);
    const script = Object.hasOwn(this.scripts, input.token) ? this.scripts[input.token] : undefined;
    const step = script?.[index];
    if (script && !step) throw new ProviderError('invalid_payload');
    if (step?.type === 'timeout') throw new ProviderError('timeout');
    if (step?.type === 'transient') throw new ProviderError('transient');
    if (step?.type === 'rate_limit') {
      throw new ProviderError('rate_limit', parseRetryAfter(step.retryAfter));
    }
    if (step?.type === 'page') return structuredClone(step.page);
    return {
      posts: structuredClone(this.dataset.filter((post) =>
        post.capturedAt >= input.from && post.capturedAt < input.to)),
      nextCursor: null,
    };
  }
}

export function demoScripts(): Record<string, FakeStep[]> {
  const success: FakeStep = { type: 'page', page: { posts: demoPosts, nextCursor: null } };
  return {
    'fake:timeout-once': [{ type: 'timeout' }, success],
    'fake:timeout': [{ type: 'timeout' }, { type: 'timeout' }, { type: 'timeout' }],
    'fake:rate-limit': [{ type: 'rate_limit', retryAfter: '1' }, success],
    'fake:deferred': [{ type: 'rate_limit', retryAfter: '60' }, success],
  };
}
