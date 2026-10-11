import { ProviderError } from './provider.js';
import type { MetricsProvider, ProviderPage, ProviderPostSnapshot, FetchInput } from './provider.js';
import { Store } from './store.js';
import { InputError, instant, nonEmptyString, object } from './types.js';
import type { Clock, Connection, Network, Sleeper, SyncRun } from './types.js';

export type SyncOptions = {
  timeoutMs: number;
  maxAttempts: number;
  maxWaitMs: number;
  backoffMs: number;
  maxPages: number;
};
export const defaultOptions: SyncOptions = {
  timeoutMs: 1000, maxAttempts: 3, maxWaitMs: 5000, backoffMs: 100, maxPages: 100,
};

export class SyncService {
  readonly options: SyncOptions;
  private readonly active = new Set<string>();

  constructor(readonly store: Store, private readonly provider: MetricsProvider,
    private readonly clock: Clock, private readonly sleeper: Sleeper,
    options: Partial<SyncOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxWaitMs' || key === 'backoffMs' ? 0 : 1) ||
          value > 2_147_483_647) throw new Error(`Configuração inválida: ${key}`);
    }
  }

  createConnection(body: unknown): Omit<Connection, 'token'> {
    const input = object(body);
    const creatorId = nonEmptyString(input.creator_id, 'creator_id');
    const token = nonEmptyString(input.token, 'token');
    const provider = nonEmptyString(input.provider, 'provider');
    if (!['instagram', 'tiktok', 'youtube', 'x'].includes(provider)) {
      throw new InputError('provider deve ser instagram, tiktok, youtube ou x.');
    }
    const { token: _token, ...connection } = this.store.createConnection(
      creatorId, provider as Network, token, this.clock.now().toISOString());
    return connection;
  }

  requireConnection(id: string): Connection {
    const connection = this.store.getConnection(id);
    if (!connection) throw new InputError('Conexão não encontrada.', 404);
    return connection;
  }

  async sync(connectionId: string, body: unknown): Promise<SyncRun> {
    const input = object(body);
    const from = instant(input.from, 'from');
    const to = instant(input.to, 'to');
    if (from >= to) throw new InputError('A janela exige from < to.');
    const connection = this.requireConnection(connectionId);
    if (this.active.has(connectionId)) throw new InputError('Já existe um sync em execução nesta conexão.', 409);
    const run = this.store.createRun(connectionId, from, to, this.clock.now().toISOString());
    this.active.add(connectionId);
    const finish = (status: SyncRun['status'], reason: string | null = null): SyncRun => {
      run.status = status;
      run.reason = reason;
      run.finished_at = this.clock.now().toISOString();
      this.store.saveRun(run);
      return run;
    };
    try {
      if (connection.next_eligible_at && new Date(connection.next_eligible_at).getTime() > this.clock.now().getTime()) {
        run.next_eligible_at = connection.next_eligible_at;
        return finish('deferred', 'rate_limit_cooldown');
      }
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      const observedPosts = new Set<string>();
      for (let pageNumber = 0; pageNumber < this.options.maxPages; pageNumber += 1) {
        let rawPage: ProviderPage | undefined;
        for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
          run.attempts += 1;
          this.store.saveRun(run);
          try {
            rawPage = await this.fetchWithTimeout({ connectionId, token: connection.token,
              from, to, cursor, timeoutMs: this.options.timeoutMs });
            this.store.setCooldown(connectionId, null);
            run.next_eligible_at = null;
            break;
          } catch (error) {
            if (!(error instanceof ProviderError)) return finish('failed', 'provider_error');
            if (error.kind === 'invalid_payload') return finish('failed', 'invalid_payload');
            const wait = error.kind === 'rate_limit'
              ? error.retryAfterMs ?? this.options.backoffMs : this.options.backoffMs;
            if (error.kind === 'rate_limit') {
              run.next_eligible_at = new Date(this.clock.now().getTime() + wait).toISOString();
              this.store.setCooldown(connectionId, run.next_eligible_at);
            }
            if (wait > this.options.maxWaitMs) {
              run.next_eligible_at ??= new Date(this.clock.now().getTime() + wait).toISOString();
              return finish('deferred', `${error.kind}_wait_exceeds_cap`);
            }
            if (attempt === this.options.maxAttempts) return finish('failed', `${error.kind}_attempts_exhausted`);
            await this.sleeper.sleep(wait);
          }
        }
        if (!rawPage) return finish('failed', 'attempts_exhausted');
        const fetchedAt = this.clock.now().toISOString();
        let page: ProviderPage;
        try { page = this.validatePage(rawPage, fetchedAt, from, to); }
        catch { return finish('failed', 'invalid_payload'); }
        // Cyclic pagination must terminate before persisting the repeated page.
        if (page.nextCursor !== null && seenCursors.has(page.nextCursor)) {
          return finish('failed', 'pagination_cycle');
        }
        for (const post of page.posts) observedPosts.add(post.providerPostId);
        run.summary.posts_observed = observedPosts.size;
        this.store.persistPage(run, page.posts, fetchedAt);
        if (page.nextCursor === null) return finish('succeeded');
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return finish('failed', 'page_limit_exhausted');
    } catch (error) {
      finish('failed', 'internal_error');
      throw error;
    } finally {
      this.active.delete(connectionId);
    }
  }

  private async fetchWithTimeout(input: Omit<FetchInput, 'signal'>): Promise<ProviderPage> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProviderError('timeout'));
        controller.abort();
      }, input.timeoutMs);
    });
    try {
      return await Promise.race([this.provider.fetchPosts({ ...input, signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private validatePage(page: ProviderPage, fetchedAt: string, from: string, to: string): ProviderPage {
    const data = object(page);
    if (!Array.isArray(data.posts) || (data.nextCursor !== null &&
        (typeof data.nextCursor !== 'string' || !data.nextCursor.trim()))) throw new InputError('Página inválida.');
    const posts: ProviderPostSnapshot[] = data.posts.map((raw: unknown) => {
      const post = object(raw);
      const metrics = object(post.metrics);
      for (const key of ['views', 'likes', 'comments']) {
        if (!Number.isSafeInteger(metrics[key]) || (metrics[key] as number) < 0) {
          throw new InputError('As métricas devem ser inteiros não negativos e seguros.');
        }
      }
      const capturedAt = instant(post.capturedAt, 'capturedAt');
      if (capturedAt > fetchedAt) throw new InputError('capturedAt não pode estar no futuro.');
      if (capturedAt < from || capturedAt >= to) throw new InputError('capturedAt está fora da janela solicitada.');
      return { providerPostId: nonEmptyString(post.providerPostId, 'providerPostId'), capturedAt,
        metrics: { views: metrics.views as number, likes: metrics.likes as number, comments: metrics.comments as number } };
    });
    return { posts, nextCursor: data.nextCursor as string | null };
  }
}
