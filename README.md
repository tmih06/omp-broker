# omp-broker

OpenAI- and Anthropic-compatible HTTP gateway backed by [omp](https://omp.sh) subscription logins. One process, per-client virtual API keys, any client that speaks `/v1/chat/completions`, `/v1/messages`, or `/v1/responses` — routed through `@oh-my-pi/pi-ai` to the provider account you already log in with.

```mermaid
flowchart LR
  C[OpenAI / Anthropic SDK] -->|virtual key| G[omp-broker]
  G --> S[(omp credential store)]
  G --> V[(virtual keys + budgets)]
  G --> T[wire translation + credential injection]
  T -->|OAuth| A[Anthropic Pro/Max]
  T -->|OAuth| O[ChatGPT Codex]
  T -->|OAuth| GH[GitHub Copilot]
  T -->|OAuth| GA[Antigravity / Gemini CLI]
  T -->|API key| K[OpenAI, OpenRouter, Groq, …]
```

The gateway never exposes upstream access tokens to clients. It resolves `model` → provider → credential, refreshes OAuth when needed, translates the wire format, and streams the provider response back in the client's protocol.

## Quick start

Requires Bun ≥ 1.4.4.

```bash
bun install

# Authenticate a subscription (or reuse credentials already stored by omp)
bun run login openai-codex
# other examples: anthropic, github-copilot, google-gemini-cli, google-antigravity

# Start the gateway (second terminal)
bun run serve

# Create a virtual API key (third terminal). The secret is printed once.
bun run key create local --budget 20
export OMP_KEY=omp_sk_...   # paste the printed secret

curl -s http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $OMP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai-codex/gpt-5.6-sol","messages":[{"role":"user","content":"Say hi"}]}'
```

Anthropic Messages uses the same virtual key in the native `x-api-key` header:

```bash
curl -s http://127.0.0.1:4000/v1/messages \
  -H "x-api-key: $OMP_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"github-copilot/claude-sonnet-4.5","max_tokens":128,"messages":[{"role":"user","content":"Say hi"}]}'
```

### SDKs

```ts
// OpenAI
const openai = new OpenAI({
  baseURL: "http://127.0.0.1:4000/v1",
  apiKey: process.env.OMP_KEY,
});

// Anthropic (sends x-api-key)
const anthropic = new Anthropic({
  baseURL: "http://127.0.0.1:4000",
  apiKey: process.env.OMP_KEY,
});
```

## Models

`GET /v1/models` lists chat models from providers that currently have a credential. Each row is `provider/model`; use that exact id, or the bare model id when only one authenticated provider exposes it.

```bash
bun run models                 # authenticated providers only
bun run models --all           # full bundled catalog
bun run models --provider anthropic
```

Bare ids resolve through a fixed preference order (`anthropic`, `openai-codex`, `github-copilot`, `google-antigravity`, `google-gemini-cli`, then the other authenticated providers). Override it with `OMP_BROKER_PROVIDER_ORDER=a,b,c`. Unknown ids return `404`; a known model without a credential returns `401` with the provider name.

## Frontend

`web/` is a Vite + React 19 console wired to the [Arc](https://uiarc.dev) component registry. Arc items are copied into `web/src/components/arc`, not installed as an npm package.

```bash
cd web
bun install
bun run dev      # http://127.0.0.1:5173
bun run build    # typecheck + production bundle
```

The shell follows the Circle/Linear layout: a 244px shadcn sidebar, Geist typography, 6px panel radii, bordered metric and activity grids, and Arc widgets for cards, charts, the activity heatmap, and the timeline. The usage widget is Bencho's StackedBars. Metrics, charts, usage, and activity currently use deterministic preview data while the logs page is being built; the gateway status badge polls `/healthz` for real state.

Add more items from `web/` with the shadcn CLI, for example `bunx shadcn@latest add @uiarc/dialog`. The registry is declared in `web/components.json`. The gateway does not serve the bundle; run the dev server, or host `web/dist` separately.

## Commands

| Command                     | Purpose                                                   |
| --------------------------- | --------------------------------------------------------- |
| `bun run serve`             | Start the gateway on `127.0.0.1:4000`                     |
| `bun run login <provider>`  | OAuth or API-key login, persisted to the credential store |
| `bun run logout <provider>` | Remove one provider's stored credentials                  |
| `bun run logout --all`      | Remove every stored credential (confirmation required)    |
| `bun run status`            | Show stored credentials, accounts, and token expiry       |
| `bun run providers`         | List providers available for login and which are stored   |
| `bun run models`            | List served models                                        |
| `bun run key create <name>` | Create a virtual API key (secret shown once)              |
| `bun run key list`          | List virtual keys and their policy                        |
| `bun run key revoke <id>`   | Revoke a virtual key                                      |
| `bun run token`             | Print the admin bearer token                              |
| `bun run healthcheck`       | Probe the local `/healthz` endpoint                       |

Useful flags: `--bind host:port`, `--token`, `--no-auth`, `--db path`, `--isolated`, `--omp`, `--agent-dir path`, `--manual`, `--json`, `--regenerate`, `--all`, `--yes`, `--budget`, `--period`, `--request-limit`, `--allow-model`, `--block-model`, `--allow-ip`, `--expires`.

### Login

```bash
bun run login anthropic          # OAuth, prints URL / device-code instructions
bun run login openai-codex
bun run login github-copilot
bun run login openrouter         # API key providers prompt for the key
bun run login anthropic --manual # also accept a pasted redirect URL/code
```

When the provider uses a loopback callback, the flow prints the URL; open it on any machine that can reach the callback port (SSH-forward the port when the gateway runs remotely). `--manual` adds a paste prompt for headless setups.

## Credential storage

By default the gateway uses the same credential store as omp: `~/.omp/agent/agent.db`, or the remote auth-broker when `~/.omp/config.yml` / `OMP_AUTH_BROKER_URL` configures one. Existing `omp login` subscriptions therefore work immediately, and logins made through `omp` and this CLI are interchangeable. The gateway polls the store every five seconds, so a login in another process is picked up without a restart.

| Mode          | Selection                                  | Location                                        |
| ------------- | ------------------------------------------ | ----------------------------------------------- |
| omp (default) | nothing / `--omp`                          | `~/.omp/agent/agent.db` or configured broker    |
| isolated      | `--isolated` or `OMP_BROKER_STORAGE=local` | `~/.omp-broker/auth.db`                         |
| explicit      | `--db path` or `OMP_BROKER_DB`             | `path`                                          |
| container     | image defaults                             | `/data/auth.db` on the `omp-broker-data` volume |

`--agent-dir` targets another omp profile. `PI_CODING_AGENT_DIR` is honored by omp's discovery as usual. The container image sets `OMP_BROKER_STORAGE=local` and an explicit `/data/auth.db`, so it never reads the host's omp store.

## Endpoints

| Method | Path                    | Notes                                           |
| ------ | ----------------------- | ----------------------------------------------- |
| POST   | `/v1/chat/completions`  | OpenAI chat-completions, streaming or JSON      |
| POST   | `/v1/messages`          | Anthropic Messages, streaming or JSON           |
| POST   | `/v1/responses`         | OpenAI Responses                                |
| POST   | `/v1/pi/stream`         | Native pi-ai event stream                       |
| POST   | `/v1/keys`              | Create a virtual API key (admin)                |
| GET    | `/v1/keys`              | List virtual keys (admin)                       |
| GET    | `/v1/keys/:id`          | Read one virtual key (admin)                    |
| PATCH  | `/v1/keys/:id`          | Update budget, models, IPs, expiry (admin)      |
| DELETE | `/v1/keys/:id`          | Revoke a virtual key (admin)                    |
| GET    | `/v1/models`            | Models; filtered when called with a virtual key |
| GET    | `/v1/usage`             | Provider quota/usage (admin)                    |
| GET    | `/v1/credentials/check` | Per-credential auth probe (admin)               |
| GET    | `/v1/logs`              | Recent requests (`limit`, `before`; admin)      |
| GET    | `/v1/logs/stats`        | Dashboard aggregates (`days`, 1–30; admin)      |
| GET    | `/healthz`              | Unauthenticated liveness                        |

Auth accepts `Authorization: Bearer <token>` and Anthropic's `x-api-key: <token>`. All non-admin routes require a virtual API key; `GET /v1/models` also accepts the admin bearer, while the admin bearer is rejected on inference routes. Admin routes require the admin bearer. CORS preflight is handled for browser clients.

### Virtual API keys

A virtual key is the only way to make inference requests. Create one from the CLI:

```bash
bun run key create laptop --budget 20 --period monthly \
  --allow-model 'anthropic/*' --block-model 'anthropic/claude-opus-*' \
  --allow-ip 127.0.0.1 --request-limit 1000
```

Or over HTTP with the admin bearer:

```bash
curl -s http://127.0.0.1:4000/v1/keys \
  -H "Authorization: Bearer $(bun run token)" \
  -H "Content-Type: application/json" \
  -d '{"name":"laptop","budgetUsd":20,"budgetPeriod":"monthly","allowedModels":["anthropic/*"],"allowedIps":["127.0.0.1"]}'
```

The response is the only place the `omp_sk_...` secret appears; only its SHA-256 hash is stored. `GET /v1/keys` shows the prefix, policy, and current-window usage, never the secret.

Policy fields:

| Field                        | Meaning                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `budgetUsd` / `budgetPeriod` | Spend cap for `daily`, `monthly`, or `total`; `null` is unlimited |
| `requestLimit`               | Request cap for the same period; `null` is unlimited              |
| `allowedModels`              | Empty allows every model; `*` matches any run of characters       |
| `blockedModels`              | Applied after the allow list; blocked wins                        |
| `allowedIps`                 | Empty allows every address; exact IPv4/IPv6 matches               |
| `expiresAt`                  | Epoch milliseconds; expired keys return `401`                     |

Model patterns match both the bare model id and `provider/model`. Budgets and request counts come from the request log, so logging is required for key traffic. A request that crosses the budget is allowed to finish; the next one returns `402`. Streaming cost lands when the stream ends. If a provider reports no usage, the cost is null and only `requestLimit` is a hard cap. IP allowlists match the socket peer; behind a reverse proxy, enforce addresses at the proxy. `--no-auth` relaxes admin auth only; non-admin routes still require a key.

### Request logs

Every handled request is recorded in `$OMP_BROKER_HOME/requests.db` (SQLite, WAL). Health probes, CORS preflights, and the log routes themselves are excluded so the history reflects gateway traffic. The last 10,000 rows are kept by default; the writer prunes old rows in the background.

`GET /v1/logs` returns newest first with `limit` (1–200) and an exclusive `before` cursor. `GET /v1/logs/stats?days=7` returns a 24-hour summary (including token totals and cost), a daily series, 30-day endpoint usage, and per-route totals. Both routes require the admin bearer token.

Entries contain the method, path, status, handling duration, client address, error text, virtual key id/name, requested model, resolved provider, response request id, stream flag, and usage buckets: input (non-cached), output, cache read, cache write, reasoning, total tokens, plus the notional catalog cost. Request and response bodies, headers, and credentials are never stored.

JSON responses have usage read before the row is written. SSE rows are written as soon as headers are ready and their token and cost columns are filled when the stream ends. OpenAI streams report usage only when the client requests `stream_options.include_usage`; Anthropic Messages and OpenAI Responses streams carry usage natively. For streaming responses the duration stops when the response is returned to the client, not when the stream ends.

## Build a standalone server

```bash
bun run build
# dist/omp-broker — one executable, native addon embedded

OMP_BROKER_TOKEN=change-me ./dist/omp-broker serve --bind=0.0.0.0:4000
./dist/omp-broker key create local --budget 20
```

The build uses `--aot --trim --minify` and embeds a zstd-compressed `pi_natives` addon, producing a ~158 MB executable. On Linux most of the reduction currently comes from compression rather than `--trim`; both flags are wired in for newer Bun runtimes. The first run extracts the addon into `$OMP_BROKER_HOME/natives/<version>/` (~107 MB), then reuses it. Override the location with `PI_NATIVES_DIR`. Build on the target OS/architecture — Bun does not cross-compile the N-API addon.

## Docker

```bash
docker compose build
docker compose up -d
docker compose exec omp-broker omp-broker token        # admin token
docker compose exec omp-broker omp-broker key create local --budget 20
```

The image is multi-stage and runs on distroless Debian 12 as UID 10001, with no shell or Bun runtime. It is about 99 MB compressed. All state lives on the `omp-broker-data` volume:

```text
/data/auth.db        credential SQLite database (isolated from the host)
/data/keys.db        virtual API key policy (hashed secrets)
/data/requests.db    request history (SQLite, WAL)
/data/broker.token   generated gateway bearer token
/data/natives/       extracted pi_natives addon
```

The container does not mount or read `~/.omp/agent/agent.db`. Log in inside the container, or publish the provider's OAuth callback port for the login run:

```bash
docker compose exec -it omp-broker omp-broker login openai-codex --manual
# or, for a callback flow:
docker compose run --rm --service-ports -p 1455:1455 omp-broker login openai-codex
```

Compose publishes `127.0.0.1:4000` only; put TLS and auth-aware reverse proxy in front for remote clients. To use a bind mount instead of the named volume, `chown 10001:10001` the host directory. Rotate the token with `docker compose exec omp-broker omp-broker token --regenerate`.

## Configuration

| Variable                     | Default                        | Purpose                                     |
| ---------------------------- | ------------------------------ | ------------------------------------------- |
| `OMP_BROKER_BIND`            | `127.0.0.1:4000`               | Listen address                              |
| `OMP_BROKER_TOKEN`           | token file                     | Admin bearer token override                 |
| `OMP_BROKER_HOME`            | `~/.omp-broker`                | Token and SQLite directory                  |
| `OMP_BROKER_DB`              | —                              | Explicit credential SQLite path             |
| `OMP_BROKER_STORAGE`         | `omp`                          | `omp` or `local`                            |
| `OMP_BROKER_AGENT_DIR`       | —                              | omp agent/profile directory                 |
| `OMP_BROKER_PROVIDER_ORDER`  | see Models                     | Comma-separated bare-id provider preference |
| `OMP_BROKER_KEYS_DB`         | `$OMP_BROKER_HOME/keys.db`     | Virtual API key SQLite path                 |
| `OMP_BROKER_LOG_DB`          | `$OMP_BROKER_HOME/requests.db` | Request history SQLite path                 |
| `OMP_BROKER_LOG_MAX_ENTRIES` | `10000`                        | Rows kept before old requests are pruned    |
| `PI_NATIVES_DIR`             | `$OMP_BROKER_HOME/natives`     | Extracted native addon directory            |

The admin token lives at `$OMP_BROKER_HOME/broker.token` (mode `0600`) and is generated on first use. In the container that is `/data/broker.token`. `bun run token --regenerate` replaces it; an env or `--token` value always takes precedence. Inference clients use virtual API keys instead; see below.

## Troubleshooting

- `401 unauthorized` — the virtual key is missing, wrong, revoked, or expired. Create one with `bun run key create <name>`.
- `403 virtual API key required` — inference endpoints reject the admin token; clients must use an `omp_sk_...` key.
- `402` / `429` — the key's budget is exhausted or its request limit is reached.
- `403 IP address not allowed` / `403 model is not allowed` — the key policy rejected the request.
- `401 No credential available for provider …` — log in to that provider, or pick a model from an authenticated provider.
- `404 Unknown model` — model ids are case-sensitive in requests; use the exact `provider/model` row from `GET /v1/models`.
- GitHub Copilot returns `model_not_supported` — enable the model in VS Code's Copilot model picker first; the subscription only exposes enabled models.
- Remote OAuth callback never completes — forward the printed loopback port over SSH, or rerun `bun run login <provider> --manual` and paste the redirect URL.

## Security notes

- Binds to loopback by default. Put TLS and network policy in front of it before exposing it.
- The Docker image runs non-root on distroless; only `/data` is writable.
- `--no-auth` is refused on non-loopback binds unless `--allow-remote` is passed. It disables admin auth only; inference still requires a virtual key.
- Tokens, refresh tokens, and API keys are never written to logs or responses; upstream auth is injected server-side.
- Virtual key secrets are stored as SHA-256 hashes and shown once at creation. The admin bearer is rejected on inference routes.
- Request logs store request metadata (path, status, duration, client, key id/name, model, provider, token buckets, cost), never headers, bodies, or credentials; the log routes require the admin bearer.
- OAuth subscription endpoints are sanctioned for their providers' own clients. Check your provider's terms before sharing access with other users or workloads.

## Development

```bash
bun test        # protocol round-trips against a mock upstream + catalog tests
bun run check   # tsc --noEmit
bun run fmt     # Oxfmt via Vite+
bun run lint    # Oxlint via Vite+
```

`bun run fmt:check` verifies formatting without writing; lint and format settings live in `vite.config.ts`.

The e2e test starts the real Bun server with injected `fetch`, exercises virtual key auth and policy (model, IP, budget), OpenAI chat (JSON + SSE), Anthropic Messages (JSON with `x-api-key`), OpenAI Responses, key CRUD, model listing, and the request log routes.

## Library use

The modules under `src/` are importable from Bun:

```ts
import { ApiKeyStore } from "./src/api-keys";
import { RequestLog } from "./src/request-log";
import { openStorage } from "./src/storage";
import { startGateway } from "./src/server";

const { storage } = await openStorage({ isolated: true });
const apiKeys = ApiKeyStore.open();
const requestLog = RequestLog.open();
const { key } = apiKeys.create({ name: "dev" });
const gateway = await startGateway({ storage, apiKeys, requestLog, bearerTokens: ["admin"] });
console.log(gateway.url, key); // clients use `key`; `admin` only reaches admin routes
```
