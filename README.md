# Métricas das redes do criador — Conty 04

API que recebe uma conexão já autorizada e sincroniza métricas por um provedor simulado. Respostas repetidas e janelas sobrepostas preservam um único snapshot por observação. Os totais usam a medição mais recente de cada post, sem somar contadores acumulados de épocas diferentes.

O [enunciado oficial](https://challenge.appconty.com/desafios/rastreio-redes) pede API, fake, testes, idempotência, timeout e rate limit com espera/tentativas limitadas. Node 22, TypeScript estrito, Hono, SQLite nativo e Vitest são escolhas deste projeto. Não há OAuth, frontend ou acesso a redes reais.

## Rodar

Node **22.13 ou posterior da série 22**; validado com **22.23.3**. Não é necessário instalar SQLite separadamente. O aviso de recurso experimental de `node:sqlite` no Node 22 é esperado.

```sh
npm ci
npm run typecheck
npm test
npm run demo
npm start
```

`npm start` atende em `http://127.0.0.1:3000` e grava `data/metrics.db`. `npm run dev` inicia com recarga. `npm run demo` executa requests contra a própria aplicação Hono e SQLite em memória, imprime requests/responses completos e avança um relógio controlado; o servidor usa relógio e espera reais.

| Variável | Padrão | Significado |
|---|---:|---|
| `PORT` | 3000 | Porta local |
| `DB_PATH` | `./data/metrics.db` | Arquivo SQLite; aceita `:memory:` |
| `TIMEOUT_MS` | 1000 | Timeout de cada chamada ao provedor |
| `MAX_ATTEMPTS` | 3 | Máximo de chamadas **por página**, incluindo a primeira |
| `MAX_WAIT_MS` | 5000 | Máximo permitido para **cada espera** de retry |
| `BACKOFF_MS` | 100 | Espera fixa para timeout, falha transitória e header ausente/inválido |
| `MAX_PAGES` | 100 | Máximo de páginas aceitas por sync |

`SyncRun.attempts` é o acumulado de chamadas de todas as páginas. Uma página bem-sucedida inicia um novo orçamento na página seguinte: duas páginas com um timeout na segunda podem terminar com `attempts: 3` mesmo quando `MAX_ATTEMPTS=2`. A execução inteira tem no máximo `MAX_PAGES × MAX_ATTEMPTS` chamadas; com os padrões, 300. O teto de espera é por intervalo, não a soma das esperas da execução. Cursores cíclicos também encerram o sync. Todas as opções numéricas são inteiros; timeout, tentativas e páginas devem ser positivos; espera e backoff podem ser zero.

## Arquitetura e persistência

```text
Hono (app.ts) → SyncService → MetricsProvider → FakeMetricsProvider
                    ↓
                Store → node:sqlite
```

`MetricsProvider.fetchPosts` recebe token, conexão, janela, cursor, timeout e um sinal de cancelamento. Devolve posts normalizados e próximo cursor. O adaptador interpreta `Retry-After` e transforma timeout, erro transitório e rate limit em erros tipados; o serviço decide espera, retry e persistência sem conhecer headers ou formatos brutos de redes sociais.

Cada página é validada inteira antes da transação SQLite que grava posts, snapshots e resumo da execução. Se uma página posterior falha, as páginas anteriores permanecem gravadas e o run termina `failed` com o resumo parcial. Nunca há uma transação aberta durante espera ou chamada assíncrona.

- Post: único por `(connection_id, provider_post_id)`.
- Snapshot: único por `(connection_id, provider_post_id, captured_at)`, com timestamp normalizado para UTC.
- `captured_at`: instante da medição pelo provedor; faz parte da identidade.
- `fetched_at`: instante da primeira busca que persistiu aquela observação; um replay não o altera.
- `last_seen_at`: busca mais recente que observou o post, inclusive replay. Cada run tem início/fim próprios.
- Mesma identidade com números diferentes: **primeira gravação vence**. O original é preservado; `summary.conflicts` guarda identidade, valores originais e recebidos. Não há linha adicional nem soma extra.
- Nova medição do mesmo post: preserva o histórico e substitui o valor vigente apenas se `captured_at` for posterior. Views de 100 seguidas por 150 resultam em **150**, não 250. Uma medição antiga que chega depois não regride o valor vigente.

Neste fake, a janela é **de captura**, `[from, to)`: inclui `from` e exclui `to`. O serviço rejeita uma página que contenha captura fora da janela, no futuro, sem fuso explícito ou com métricas que não sejam inteiros seguros não negativos. Isso é uma decisão do projeto; um adaptador para uma rede que filtre por data de publicação precisaria ajustar explicitamente esse contrato. Os totais do endpoint são de todos os posts já conhecidos da conexão, independentemente da janela do último sync. Somatórios acima de `Number.MAX_SAFE_INTEGER` saem como texto decimal para preservar a precisão.

## Retry, timeout e 429

O fake pode lançar timeout imediatamente. O serviço também impõe um timeout real com timer, `Promise.race` e `AbortController`, inclusive para um provedor que nunca responde. A regra de retry usa `Clock` e `Sleeper` injetados; os testes verificam o instante de cada chamada sem esperas reais.

Para `429`, `Retry-After` aceita segundos inteiros não negativos:

1. Prazo **menor ou igual** a `MAX_WAIT_MS`: aguarda o prazo inteiro e repete se houver tentativa disponível na página. Igualdade ao teto é permitida; zero permite retry imediato.
2. Prazo **maior**: termina `deferred`, com `reason: rate_limit_wait_exceeds_cap` e `next_eligible_at`. Não dorme pelo teto e não tenta antecipadamente.
3. Última tentativa com prazo dentro do teto: termina `failed`, sem espera inútil nem chamada adicional. A elegibilidade continua registrada.
4. Nova chamada antes de `next_eligible_at`: cria run `deferred`, `attempts: 0`, `reason: rate_limit_cooldown`, sem chamar o provedor. No instante exato ou depois dele, uma nova chamada pode prosseguir.

A elegibilidade de rate limit fica no SQLite, por conexão, inclusive após reabrir o banco. Header ausente, negativo, fracionário, texto inválido ou HTTP-date usa o backoff fixo, sujeito aos mesmos tetos. HTTP-date não é suportado nesta entrega. Um inteiro tão grande que não possa ser representado com precisão/como data termina `invalid_payload` sem retry antecipado. Falhas transitórias esgotadas terminam `failed`; se o próprio backoff ultrapassar o teto, terminam `deferred`. A elegibilidade persistente entre requests é aplicada ao rate limit. Não há scheduler: o cliente chama de novo quando elegível.

## API

| Método e caminho | Corpo / resultado |
|---|---|
| `POST /connections` | `{ creator_id, provider, token }` → conexão, sem devolver token |
| `POST /connections/:id/syncs` | `{ from, to }` → run com estado, tentativas, tempos, motivo e resumo |
| `GET /syncs/:id` | Mesmo run persistido |
| `GET /connections/:id/posts?history=true` | Posts, snapshot atual e histórico opcional |
| `GET /connections/:id/metrics` | `{ posts, views, likes, comments }` dos snapshots atuais |

`provider`: `instagram`, `tiktok`, `youtube` ou `x`. Neste desafio todos usam o mesmo adaptador falso. Timestamp de entrada exige ISO com fuso, por exemplo `2026-10-01T00:00:00Z`. `from >= to` é recusado antes de chamar o provedor.

Criações de conexão/run retornam `201`; consultas, `200`; input inválido, `400`; recurso ausente, `404`; sync concorrente na mesma conexão, `409`. Um run `failed` ou `deferred` continua sendo um recurso criado, com `201`: consulte seu `status`. Erros de API têm `{ "error": "mensagem" }`. O resumo contém páginas persistidas, posts distintos observados, snapshots inseridos, atualizações do snapshot vigente, replays ignorados e conflitos auditados.

### Requests executáveis (PowerShell)

Com `npm start` em outro terminal:

```powershell
$base = 'http://127.0.0.1:3000'
$connection = Invoke-RestMethod "$base/connections" -Method Post -ContentType 'application/json' -Body '{"creator_id":"creator-demo","provider":"instagram","token":"fake:success"}'
$window = '{"from":"2026-10-01T00:00:00Z","to":"2026-10-10T00:00:00Z"}'
$run = Invoke-RestMethod "$base/connections/$($connection.id)/syncs" -Method Post -ContentType 'application/json' -Body $window
$run | ConvertTo-Json -Depth 10
Invoke-RestMethod "$base/connections/$($connection.id)/metrics"
Invoke-RestMethod "$base/connections/$($connection.id)/posts?history=true"
Invoke-RestMethod "$base/syncs/$($run.id)"

# Replay: zero inseridos, duas duplicatas.
Invoke-RestMethod "$base/connections/$($connection.id)/syncs" -Method Post -ContentType 'application/json' -Body $window
# Sobreposição: post-2 chega de novo; totais continuam 300/30/6.
Invoke-RestMethod "$base/connections/$($connection.id)/syncs" -Method Post -ContentType 'application/json' -Body '{"from":"2026-10-04T00:00:00Z","to":"2026-10-10T00:00:00Z"}'
Invoke-RestMethod "$base/connections/$($connection.id)/metrics"
```

Resultado dos totais, também executado e verificado por `npm run demo`:

```json
{ "posts": 2, "views": 300, "likes": 30, "comments": 6 }
```

Trechos dos runs do demo; a saída completa inclui IDs, janelas, `started_at`, `finished_at`, `reason` e `next_eligible_at`:

```json
{
  "status": "succeeded", "attempts": 1,
  "summary": {
    "pages": 1, "posts_observed": 2, "snapshots_inserted": 2,
    "current_updated": 0, "duplicates": 0, "conflicts": []
  }
}
```

Repetindo a mesma request:

```json
{
  "status": "succeeded", "attempts": 1,
  "summary": {
    "pages": 1, "posts_observed": 2, "snapshots_inserted": 0,
    "current_updated": 0, "duplicates": 2, "conflicts": []
  }
}
```

### Roteiros do fake

| Token fictício | Comportamento da conexão |
|---|---|
| `fake:success` (ou texto sem roteiro) | Dataset fixo: post-1 com 100 views em 01/10 e post-2 com 200 em 05/10; filtra a janela de captura |
| `fake:timeout-once` | Timeout, depois sucesso (`attempts: 2`) |
| `fake:timeout` | Três timeouts, falha finita |
| `fake:rate-limit` | `429`, `Retry-After: 1`, depois sucesso |
| `fake:deferred` | `429`, `Retry-After: 60`, depois sucesso quando elegível |

Os roteiros são sequências finitas, consumidas por conexão; após o fim, retornam `invalid_payload`. Para repetir um cenário, crie nova conexão. O dataset sem roteiro pode ser consultado quantas vezes for preciso. Scripts e posição do fake são apenas memória; ao reiniciar o processo, a sequência recomeça, mas o cooldown e os dados reais do serviço permanecem no SQLite. Os testes podem injetar qualquer sequência de `FakeStep`, com páginas, duplicatas, conflitos e cursores.

Para demonstrar deferimento no servidor, crie uma conexão como acima trocando o token para `fake:deferred`, e sincronize a mesma janela. A segunda request imediata não chama o provedor. Depois de 60 segundos, nova request prossegue. No demo controlado não há espera real. Trecho de sua resposta executada:

```json
{
  "status": "deferred", "attempts": 1,
  "reason": "rate_limit_wait_exceeds_cap",
  "started_at": "2026-10-11T12:00:01.100Z",
  "finished_at": "2026-10-11T12:00:01.100Z",
  "next_eligible_at": "2026-10-11T12:01:01.100Z",
  "summary": {
    "pages": 0, "posts_observed": 0, "snapshots_inserted": 0,
    "current_updated": 0, "duplicates": 0, "conflicts": []
  }
}
```

## Validação e limites

Validação em 11/10/2026, Node 22.23.3: instalação limpa com `npm ci`, typecheck, **50/50 testes**, demo e servidor iniciado com `npm start` passaram. Requests HTTP locais confirmaram replay/sobreposição sem alterar as 300 views, consulta do histórico/run, espera real de 1 segundo no `429` e deferimento sem chamada antecipada. Duas revisões independentes por IA aprovaram a versão final após a correção da validação da janela.

Os testes usam SQLite real e requests da aplicação: replay, sobreposição, conflito auditado, mudança de métrica, observação antiga, dois posts iguais, isolamento entre conexões, timestamps equivalentes, validação atômica da página, limites da janela, precisão de totais, paginação, ciclos, resultado parcial, timeout real, retry transitório, `429` abaixo/igual/acima do teto, última tentativa, header inválido, cooldown até o milissegundo de elegibilidade e reabertura do banco. O demo tem teste que confere as respostas exemplificadas acima.

É uma demonstração local em um processo, com guarda de concorrência por conexão na instância do serviço. Não possui autenticação da API, gestão de segredos, OAuth, integrações externas, scheduler, fila ou coordenação distribuída. Tokens fictícios ficam em texto no banco. Uma queda abrupta pode deixar um run `running`; recuperação automática de runs interrompidos ficou fora. Para produção, priorizaria autenticação e armazenamento de credenciais, locks entre processos, recuperação de execuções, escopo real de rate limit e contrato do adaptador de cada rede. Essas extensões não são requisitos oficiais desta entrega.

## Uso de IA e revisão

A análise do enunciado, o planejamento, a implementação, os testes, o README e a revisão técnica foram realizados com apoio do Codex/IA. Dois agentes de IA fizeram revisão independente; os resultados informados vêm da execução real dos testes e exemplos deste repositório em Node 22. Marco **ainda não realizou revisão humana** do código e dos resultados. A revisão automatizada não é apresentada como revisão humana.
