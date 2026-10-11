import { Hono } from 'hono';
import { SyncService } from './sync-service.js';
import { InputError } from './types.js';
import type { Context } from 'hono';

async function body(context: Context): Promise<unknown> {
  try { return await context.req.json(); }
  catch { throw new InputError('JSON inválido.'); }
}

export function createApp(service: SyncService): Hono {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof InputError) return context.json({ error: error.message }, error.status);
    return context.json({ error: 'Erro interno.' }, 500);
  });
  app.get('/', (context) => context.json({ service: 'conty-metricas-redes', provider: 'simulated' }));
  app.post('/connections', async (context) =>
    context.json(service.createConnection(await body(context)), 201));
  app.post('/connections/:id/syncs', async (context) =>
    context.json(await service.sync(context.req.param('id'), await body(context)), 201));
  app.get('/syncs/:id', (context) => {
    const run = service.store.getRun(context.req.param('id'));
    if (!run) throw new InputError('Sync não encontrado.', 404);
    return context.json(run);
  });
  app.get('/connections/:id/posts', (context) => {
    const id = context.req.param('id');
    service.requireConnection(id);
    const history = context.req.query('history');
    if (history !== undefined && history !== 'true' && history !== 'false') {
      throw new InputError('history deve ser true ou false.');
    }
    return context.json({ posts: service.store.listPosts(id, history === 'true') });
  });
  app.get('/connections/:id/metrics', (context) => {
    const id = context.req.param('id');
    service.requireConnection(id);
    return context.json(service.store.metrics(id));
  });
  app.notFound((context) => context.json({ error: 'Rota não encontrada.' }, 404));
  return app;
}
