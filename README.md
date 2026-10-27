# omp-gateway

OpenAI- and Anthropic-compatible HTTP gateway backed by [omp](https://omp.sh) subscription logins. One process, one bearer token, any client that speaks `/v1/chat/completions`, `/v1/messages`, or `/v1/responses` — routed through `@oh-my-pi/pi-ai` to the provider account you already log in with.

```mermaid
flowchart LR
  C[OpenAI / Anthropic SDK] -->|Bearer or x-api-key| G[omp-gateway]
  G --> S[(omp credential store)]
  G --> T[wire translation + credential injection]
  T -->|OAuth| A[Anthropic Pro/Max]
  T -->|OAuth| O[ChatGPT Codex]
  T -->|OAuth| GH[GitHub Copilot]
  T -->|OAuth| GA[Antigravity / Gemini CLI]
  T -->|API key| K[OpenAI, OpenRouter, Groq, …]
```

The gateway never exposes upstream access tokens to clients. It resolves `model` → provider → credential, refreshes OAuth when needed, translates the wire format, and streams the provider response back in the client's protocol.

## Quick start

Requires Bun ≥ 1.3.14.

```bash
bun install

# Authenticate a subscription (or reuse credentials already stored by omp)
bun run login openai-codex
# other examples: anthropic, github-copilot, google-gemini-cli, google-antigravity

# Start the gateway (second terminal)
bun run serve

# Fetch the bearer token and call it
TOKEN=$(bun run token)
curl -s http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai-codex/gpt-5.6-sol","messages":[{"role":"user","content":"Say hi"}]}'
```

Anthropic Messages, using the same token in the native `x-api-key` header:

```bash
curl -s http://127.0.0.1:4000/v1/messages \
  -H "x-api-key: $TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"github-copilot/claude-sonnet-4.5","max_tokens":128,"messages":[{"role":"user","content":"Say hi"}]}'
```

### SDKs

```ts
// OpenAI
const openai = new OpenAI({
  baseURL: "http://127.0.0.1:4000/v1",
  apiKey: process.env.OMP_GATEWAY_TOKEN,
});

// Anthropic (sends x-api-key)
const anthropic = new Anthropic({
  baseURL: "http://127.0.0.1:4000",
  apiKey: process.env.OMP_GATEWAY_TOKEN,
});
```

## Models

`GET /v1/models` lists chat models from providers that currently have a credential. Each row is `provider/model`; use that exact id, or the bare model id when only one authenticated provider exposes it.

```bash
bun run models                 # authenticated providers only
bun run models --all           # full bundled catalog
bun run models --provider anthropic
```

Bare ids resolve through a fixed preference order (`anthropic`, `openai-codex`, `github-copilot`, `google-antigravity`, `google-gemini-cli`, then the other authenticated providers). Override it with `OMP_GATEWAY_PROVIDER_ORDER=a,b,c`. Unknown ids return `404`; a known model without a credential returns `401` with the provider name.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run serve` | Start the gateway on `127.0.0.1:4000` |
| `bun run login <provider>` | OAuth or API-key login, persisted to the credential store |
| `bun run logout <provider>` | Remove one provider's stored credentials |
| `bun run logout --all` | Remove every stored credential (confirmation required) |
| `bun run status` | Show stored credentials, accounts, and token expiry |
| `bun run providers` | List providers available for login and which are stored |
| `bun run models` | List served models |
| `bun run token` | Print the gateway bearer token |

Useful flags: `--bind host:port`, `--token`, `--no-auth`, `--db path`, `--isolated`, `--omp`, `--agent-dir path`, `--manual`, `--json`, `--regenerate`, `--all`, `--yes`.

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

| Mode | Selection | Location |
| --- | --- | --- |
| omp (default) | nothing / `--omp` | `~/.omp/agent/agent.db` or configured broker |
| isolated | `--isolated` or `OMP_GATEWAY_STORAGE=local` | `~/.omp-gateway/auth.db` |
| explicit | `--db path` or `OMP_GATEWAY_DB` | `path` |

`--agent-dir` targets another omp profile. `PI_CODING_AGENT_DIR` is honored by omp's discovery as usual.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI chat-completions, streaming or JSON |
| POST | `/v1/messages` | Anthropic Messages, streaming or JSON |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/pi/stream` | Native pi-ai event stream |
| GET | `/v1/models` | Models with credentials |
| GET | `/v1/usage` | Provider quota/usage for authenticated accounts |
| GET | `/v1/credentials/check` | Per-credential auth probe |
| GET | `/healthz` | Unauthenticated liveness |

Auth accepts `Authorization: Bearer <token>` and Anthropic's `x-api-key: <token>`. CORS preflight is handled for browser clients.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_GATEWAY_BIND` | `127.0.0.1:4000` | Listen address |
| `OMP_GATEWAY_TOKEN` | token file | Bearer token override |
| `OMP_GATEWAY_HOME` | `~/.omp-gateway` | Token (and isolated DB) directory |
| `OMP_GATEWAY_DB` | — | Explicit credential SQLite path |
| `OMP_GATEWAY_STORAGE` | `omp` | `omp` or `local` |
| `OMP_GATEWAY_AGENT_DIR` | — | omp agent/profile directory |
| `OMP_GATEWAY_PROVIDER_ORDER` | see Models | Comma-separated bare-id provider preference |

The token lives at `$OMP_GATEWAY_HOME/gateway.token` (mode `0600`) and is generated on first use. `bun run token --regenerate` replaces it; an env or `--token` value always takes precedence.

## Troubleshooting

- `401 unauthorized` — the client token differs from `bun run token`; an env or `--token` override may be winning.
- `401 No credential available for provider …` — log in to that provider, or pick a model from an authenticated provider.
- `404 Unknown model` — model ids are case-sensitive in requests; use the exact `provider/model` row from `GET /v1/models`.
- GitHub Copilot returns `model_not_supported` — enable the model in VS Code's Copilot model picker first; the subscription only exposes enabled models.
- Remote OAuth callback never completes — forward the printed loopback port over SSH, or rerun `bun run login <provider> --manual` and paste the redirect URL.

## Security notes

- Binds to loopback by default. Put TLS and network policy in front of it before exposing it.
- `--no-auth` is refused on non-loopback binds unless `--allow-remote` is passed.
- Tokens, refresh tokens, and API keys are never written to logs or responses; upstream auth is injected server-side.
- OAuth subscription endpoints are sanctioned for their providers' own clients. Check your provider's terms before sharing access with other users or workloads.

## Development

```bash
bun test        # protocol round-trips against a mock upstream + catalog tests
bun run check   # tsc --noEmit
```

The e2e test starts the real Bun server with injected `fetch`, exercises OpenAI chat (JSON + SSE), Anthropic Messages (JSON with `x-api-key`), OpenAI Responses, auth failures, and model listing.

## Library use

The modules under `src/` are importable from Bun:

```ts
import { openStorage } from "./src/storage";
import { startGateway } from "./src/server";

const { storage } = await openStorage({ isolated: true });
const gateway = await startGateway({ storage, bearerTokens: ["secret"] });
console.log(gateway.url);
```
