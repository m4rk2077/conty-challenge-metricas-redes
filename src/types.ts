export type Network = 'instagram' | 'tiktok' | 'youtube' | 'x';

export type Connection = {
  id: string;
  creator_id: string;
  provider: Network;
  token: string;
  created_at: string;
  next_eligible_at: string | null;
};

export type Metrics = { views: number; likes: number; comments: number };
export type Snapshot = Metrics & {
  id: string;
  connection_id: string;
  provider_post_id: string;
  captured_at: string;
  fetched_at: string;
};
export type Post = {
  connection_id: string;
  provider_post_id: string;
  first_seen_at: string;
  last_seen_at: string;
  current: Snapshot;
  history?: Snapshot[];
};
export type Conflict = {
  provider_post_id: string;
  captured_at: string;
  original: Metrics;
  received: Metrics;
};
export type SyncSummary = {
  pages: number;
  posts_observed: number;
  snapshots_inserted: number;
  current_updated: number;
  duplicates: number;
  conflicts: Conflict[];
};
export type SyncRun = {
  id: string;
  connection_id: string;
  window_from: string;
  window_to: string;
  status: 'running' | 'succeeded' | 'failed' | 'deferred';
  attempts: number;
  started_at: string;
  finished_at: string | null;
  next_eligible_at: string | null;
  reason: string | null;
  summary: SyncSummary;
};

export interface Clock { now(): Date }
export interface Sleeper { sleep(ms: number): Promise<void> }
export const systemClock: Clock = { now: () => new Date() };
export const systemSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class InputError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new InputError(`${field} deve ser um texto de 1 a 500 caracteres.`);
  }
  return value.trim();
}

// Require an explicit offset and a real calendar date; canonicalize identity to UTC.
export function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new InputError(`${field} deve ser um timestamp ISO com fuso explícito.`);
  }
  const datePart = value.slice(0, 10);
  const date = new Date(value);
  const calendar = new Date(`${datePart}T00:00:00Z`);
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const zone = value.match(/[+-](\d{2}):(\d{2})$/);
  if (!Number.isFinite(date.getTime()) || calendar.toISOString().slice(0, 10) !== datePart ||
      hour > 23 || minute > 59 || second > 59 ||
      (zone && (Number(zone[1]) > 23 || Number(zone[2]) > 59))) {
    throw new InputError(`${field} contém data ou horário inválido.`);
  }
  return date.toISOString();
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError('O corpo deve ser um objeto JSON.');
  }
  return value as Record<string, unknown>;
}
