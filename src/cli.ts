#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { OAuthLoginIdentity } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthAuthInfo, OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth";
import { ApiKeyStore, apiKeyStatus, type BudgetPeriod } from "./api-keys";
import { DEFAULT_BIND, VERSION, bindHost, bindPort, isLoopbackBind, resolveToken, providerOrder } from "./config";
import { credentialRows, listLoginProviders, loginProvider, removeProvider, storedProviders } from "./credentials";
import { createModelCatalog, storageProviderAvailability } from "./models";
import { Prompter } from "./prompt";
import { RequestLog } from "./request-log";
import { startGateway } from "./server";
import { openStorage, type StorageOptions } from "./storage";

interface CliValues {
	help?: boolean;
	version?: boolean;
	bind?: string;
	token?: string;
	"no-auth"?: boolean;
	"allow-remote"?: boolean;
	db?: string;
	omp?: boolean;
	isolated?: boolean;
	"agent-dir"?: string;
	manual?: boolean;
	all?: boolean;
	yes?: boolean;
	json?: boolean;
	regenerate?: boolean;
	provider?: string;
	budget?: string;
	period?: string;
	"request-limit"?: string;
	"allow-model"?: string[];
	"block-model"?: string[];
	"allow-ip"?: string[];
	expires?: string;
}

function printHelp(): void {
	console.log(`omp-broker v${VERSION} — OpenAI/Anthropic-compatible API for omp subscription logins

USAGE
  omp-broker <command> [options]

COMMANDS
  serve                 Start the gateway (default ${DEFAULT_BIND})
  login <provider>      Log in with OAuth or an API key and store the credential
  logout [provider]     Remove stored credentials (--all removes every provider)
  status                Show stored credentials
  providers             Show providers available for login
  models                List models served by authenticated providers
  token                 Print the admin bearer token
  key create <name>     Create a virtual API key (shown once)
  key list              List virtual API keys
  key revoke <id>       Revoke a virtual API key
  healthcheck           Probe the local /healthz endpoint (container healthcheck)

OPTIONS
  --bind <host:port>    Listen address (env: OMP_BROKER_BIND)
  --token <token>       Use this admin bearer instead of the token file
  --no-auth             Disable admin bearer auth; inference still needs a key
  --allow-remote        Permit --no-auth on a non-loopback bind
  --db <path>           Use an isolated SQLite credential store
  --omp                  Force the omp credential store (default)
  --isolated            Use ~/.omp-broker/auth.db
  --agent-dir <path>    omp profile agent directory
  --manual              Login: also accept a pasted redirect URL or code
  --all                 Logout: remove every provider
  --yes, -y             Skip the logout confirmation
  --json                Machine-readable output
  --regenerate          Token: replace the token file
  --budget <usd>        Key create: spending budget (default unlimited)
  --period <period>     Key create: daily, monthly (default), or total
  --request-limit <n>   Key create: request cap for the period
  --allow-model <glob>  Key create: allow a model/pattern (repeatable)
  --block-model <glob>  Key create: block a model/pattern (repeatable)
  --allow-ip <addr>     Key create: allow a client address (repeatable)
  --expires <date>      Key create: ISO date or epoch milliseconds
  -h, --help            Show this help
  -v, --version         Show the version

ENDPOINTS
  POST /v1/chat/completions    OpenAI chat-completions
  POST /v1/messages            Anthropic Messages
  POST /v1/responses           OpenAI Responses
  GET  /v1/models              Models with credentials
  GET  /v1/usage               Provider quota/usage
  GET  /v1/logs                Recent request history (admin)
  GET  /v1/logs/stats          Dashboard aggregates (admin)
  GET  /v1/keys                List virtual API keys (admin)
  GET  /healthz                Liveness

EXAMPLES
  bun run login openai-codex
  bun run key create laptop --budget 20 --allow-model 'anthropic/*'
  bun run start --bind=0.0.0.0:4000
  curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer $OMP_KEY"`);
}

function stringValue(value: string | boolean | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function storageOptions(values: CliValues): StorageOptions {
	return {
		db: stringValue(values.db),
		omp: Boolean(values.omp),
		isolated: Boolean(values.isolated),
		agentDir: stringValue(values["agent-dir"]),
	};
}

function printTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)));
	const line = (cells: string[]) =>
		cells
			.map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
			.join("  ")
			.trimEnd();
	console.log(line(headers));
	console.log(widths.map(width => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(line(row));
}

function formatExpiry(expiresAt: number | undefined): string {
	if (!expiresAt) return "-";
	const date = new Date(expiresAt).toISOString().replace("T", " ").slice(0, 16);
	const delta = expiresAt - Date.now();
	if (delta <= 0) return `${date} (refresh due)`;
	const minutes = Math.round(delta / 60_000);
	if (minutes < 120) return `${date} (in ${minutes}m)`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${date} (in ${hours}h)`;
	return `${date} (in ${Math.round(hours / 24)}d)`;
}

function modelRows(models: Model<Api>[]): string[][] {
	return models.map(model => [
		model.provider,
		model.id,
		model.name,
		model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "-",
		model.maxTokens ? `${Math.round(model.maxTokens / 1000)}k` : "-",
		model.input.join(","),
	]);
}

async function commandServe(values: CliValues): Promise<void> {
	const bind = stringValue(values.bind) ?? process.env.OMP_BROKER_BIND?.trim() ?? DEFAULT_BIND;
	const noAuth = Boolean(values["no-auth"]);
	if (noAuth && !isLoopbackBind(bind) && !values["allow-remote"]) {
		throw new Error(
			`Refusing --no-auth on non-loopback bind ${bind}. Pass --allow-remote if the network exposure is intentional.`,
		);
	}

	const opened = await openStorage(storageOptions(values));
	const apiKeys = ApiKeyStore.open();
	let requestLog: RequestLog | undefined;
	try {
		requestLog = RequestLog.open();
	} catch (error) {
		console.error(`request logging disabled: ${error instanceof Error ? error.message : String(error)}`);
	}
	let bearerTokens: string[] = [];
	let authLabel = "disabled (--no-auth)";
	if (!noAuth) {
		const resolved = await resolveToken({ explicit: stringValue(values.token) });
		bearerTokens = [resolved.token];
		authLabel = resolved.source === "file" ? `bearer token ${resolved.path}` : `bearer token from ${resolved.source}`;
	}

	const running = await startGateway({
		storage: opened.storage,
		bearerTokens,
		bind,
		providerOrder: providerOrder(),
		requestLog,
		apiKeys,
	});
	const providers = running.catalog.providers();
	const modelCount = running.catalog.list().length;

	console.log(`omp-broker v${VERSION} listening on ${running.url}`);
	console.log(`storage:   ${opened.label}`);
	console.log(`auth:      ${authLabel}`);
	console.log(`providers: ${providers.length > 0 ? providers.join(", ") : "(none — run `bun run login <provider>`)"}`);
	console.log(`models:    ${modelCount}`);
	console.log(`logs:      ${requestLog?.path ?? "disabled"}`);
	console.log(`keys:      ${apiKeys.path}`);
	console.log("endpoints: POST /v1/chat/completions, POST /v1/messages, POST /v1/responses");
	console.log("           GET /v1/models, /v1/usage, /v1/logs, /v1/logs/stats, /healthz");

	if (noAuth) console.warn("warning: admin auth disabled; inference still requires a virtual API key");
	if (apiKeys.list().length === 0) {
		console.warn("warning: no virtual API keys; create one with `bun run key create <name>`");
	}
	if (providers.length === 0) {
		console.warn("warning: no credentials found; requests will fail until you log in");
	}

	const poll = setInterval(() => {
		void opened.storage.credentials
			.poll()
			.catch(error => console.error("credential poll failed:", error instanceof Error ? error.message : error));
	}, 5_000);
	poll.unref?.();

	let closing = false;
	const shutdown = async (signal: string) => {
		if (closing) return;
		closing = true;
		console.log(`\n${signal} received; shutting down`);
		clearInterval(poll);
		await running.close().catch(error => console.error("gateway close failed:", error));
		requestLog?.close();
		apiKeys.close();
		opened.storage.close();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function parseKeyNumber(value: string | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
	return parsed;
}

function parseKeyExpiry(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric > 0) return numeric;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error("--expires must be an ISO date or epoch milliseconds");
	return parsed;
}

function formatTime(value: number | null): string {
	return value ? new Date(value).toISOString().replace("T", " ").slice(0, 16) : "-";
}

async function commandKey(values: CliValues, positionals: string[]): Promise<void> {
	const store = ApiKeyStore.open();
	try {
		const subcommand = positionals[1] ?? "list";
		if (subcommand === "create") {
			const name = positionals[2];
			if (!name) throw new Error("Usage: omp-broker key create <name> [options]");
			const created = store.create({
				name,
				budgetUsd: parseKeyNumber(values.budget, "--budget"),
				budgetPeriod: values.period as BudgetPeriod | undefined,
				requestLimit: parseKeyNumber(values["request-limit"], "--request-limit"),
				allowedModels: values["allow-model"],
				blockedModels: values["block-model"],
				allowedIps: values["allow-ip"],
				expiresAt: parseKeyExpiry(values.expires),
			});
			if (values.json) {
				console.log(JSON.stringify({ ...created.apiKey, key: created.key }, null, 2));
				return;
			}
			const key = created.apiKey;
			console.log(`Created API key ${key.id} (${key.name})`);
			console.log(`prefix:  ${key.keyPrefix}`);
			console.log(
				`budget:  ${key.budgetUsd === null ? "unlimited" : `$${key.budgetUsd.toFixed(2)} ${key.budgetPeriod}`}`,
			);
			console.log(`limit:   ${key.requestLimit ?? "unlimited"} requests per ${key.budgetPeriod}`);
			console.log(`models:  ${key.allowedModels.length > 0 ? key.allowedModels.join(", ") : "all"}`);
			console.log(`blocked: ${key.blockedModels.length > 0 ? key.blockedModels.join(", ") : "none"}`);
			console.log(`ips:     ${key.allowedIps.length > 0 ? key.allowedIps.join(", ") : "any"}`);
			console.log(`expires: ${key.expiresAt === null ? "never" : formatTime(key.expiresAt)}`);
			console.log(`\n${created.key}\n`);
			console.log("Store this secret now; it is not shown again.");
			return;
		}
		if (subcommand === "list") {
			const keys = store.list();
			if (values.json) {
				console.log(
					JSON.stringify(
						keys.map(key => ({ ...key, status: apiKeyStatus(key) })),
						null,
						2,
					),
				);
				return;
			}
			if (keys.length === 0) {
				console.log('No API keys. Create one with "bun run key create <name>".');
				return;
			}
			printTable(
				["ID", "NAME", "PREFIX", "STATUS", "BUDGET", "PERIOD", "LIMIT", "LAST USED"],
				keys.map(key => [
					String(key.id),
					key.name,
					key.keyPrefix,
					apiKeyStatus(key),
					key.budgetUsd === null ? "-" : `$${key.budgetUsd.toFixed(2)}`,
					key.budgetPeriod,
					key.requestLimit === null ? "-" : String(key.requestLimit),
					formatTime(key.lastUsedAt),
				]),
			);
			return;
		}
		if (subcommand === "revoke") {
			const id = Number(positionals[2]);
			if (!Number.isInteger(id) || id < 1) throw new Error("Usage: omp-broker key revoke <id>");
			const key = store.revoke(id);
			if (!key) throw new Error(`No API key with id ${id}`);
			console.log(`Revoked API key ${key.id} (${key.name})`);
			return;
		}
		throw new Error("Usage: omp-broker key <create|list|revoke> ...");
	} finally {
		store.close();
	}
}

async function commandLogin(values: CliValues, positionals: string[]): Promise<void> {
	const providerId = positionals[1];
	const opened = await openStorage(storageOptions(values));
	const prompter = new Prompter();
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);

	try {
		if (!providerId) {
			const providers = listLoginProviders(opened.storage);
			console.error("Missing provider. Available providers:\n");
			for (const provider of providers) {
				console.error(`  ${provider.id.padEnd(22)} ${provider.name}`);
			}
			throw new Error("Usage: omp-broker login <provider>");
		}

		const definition = loginProvider(providerId);
		let lastUrl: string | undefined;
		const onAuth = (info: OAuthAuthInfo) => {
			if (info.instructions) console.log(`\n${info.instructions}`);
			if (info.url && info.url !== lastUrl) {
				console.log(`\nOpen this URL in a browser:\n${info.url}`);
				lastUrl = info.url;
			}
		};
		const onPrompt = (prompt: OAuthPrompt) =>
			prompter.ask(prompt.message, {
				secret: prompt.secret,
				allowEmpty: prompt.allowEmpty,
				placeholder: prompt.placeholder,
			});

		console.log(`Logging in to ${definition.name} (${providerId})…`);
		const identity: OAuthLoginIdentity | undefined = await opened.storage.oauth.login(providerId, {
			signal: controller.signal,
			onAuth,
			onPrompt,
			onProgress: message => console.log(message),
			...(values.manual
				? {
						onManualCodeInput: (signal?: AbortSignal) =>
							prompter.ask("Paste the redirect URL or authorization code:", { signal }),
					}
				: {}),
		});

		const storedAs = definition.storeCredentialsAs ?? definition.id;
		const account = identity?.email ?? identity?.accountId ?? identity?.orgName;
		console.log(
			`\nLogged in${account ? ` as ${account}` : ""}; credential stored for ${storedAs}${
				identity?.type === "api_key" ? " (API key)" : ""
			}.`,
		);
		console.log(`Storage: ${opened.label}`);
	} finally {
		process.off("SIGINT", onSigint);
		prompter.close();
		opened.storage.close();
	}
}

async function commandLogout(values: CliValues, positionals: string[]): Promise<void> {
	const opened = await openStorage(storageOptions(values));
	const prompter = new Prompter();
	try {
		if (values.all) {
			const providers = storedProviders(opened.storage);
			if (providers.length === 0) {
				console.log("No stored credentials.");
				return;
			}
			if (!values.yes) {
				const answer = await prompter.ask(
					`Remove credentials for ${providers.length} provider(s) (${providers.join(", ")})? [y/N]`,
					{ allowEmpty: true },
				);
				if (!/^y(es)?$/i.test(answer.trim())) {
					console.log("Cancelled.");
					return;
				}
			}
			for (const provider of providers) await removeProvider(opened.storage, provider);
			console.log(`Removed credentials for: ${providers.join(", ")}`);
			return;
		}

		const provider = positionals[1];
		if (!provider) throw new Error("Usage: omp-broker logout <provider> (or --all)");
		const existed = await removeProvider(opened.storage, provider);
		console.log(existed ? `Removed stored credentials for ${provider}.` : `No stored credentials for ${provider}.`);
	} finally {
		prompter.close();
		opened.storage.close();
	}
}

async function commandStatus(values: CliValues): Promise<void> {
	const opened = await openStorage(storageOptions(values));
	try {
		const rows = credentialRows(opened.storage);
		if (values.json) {
			console.log(JSON.stringify({ storage: opened.label, credentials: rows }, null, 2));
			return;
		}
		console.log(`Storage: ${opened.label}\n`);
		if (rows.length === 0) {
			console.log("No stored credentials. Run `bun run login <provider>` or `omp login`.");
			return;
		}
		printTable(
			["PROVIDER", "TYPE", "IDENTITY", "EXPIRES"],
			rows.map(row => [row.provider, row.type, row.identity, formatExpiry(row.expiresAt)]),
		);
	} finally {
		opened.storage.close();
	}
}

async function commandProviders(values: CliValues): Promise<void> {
	const opened = await openStorage(storageOptions(values));
	try {
		const providers = listLoginProviders(opened.storage);
		if (values.json) {
			console.log(JSON.stringify(providers, null, 2));
			return;
		}
		printTable(
			["PROVIDER", "LOGIN", "NAME"],
			providers.map(provider => [
				provider.id,
				provider.hasOAuth ? "oauth" : provider.stored ? "api key" : "-",
				`${provider.name}${provider.available ? "" : " (unavailable)"}`,
			]),
		);
	} finally {
		opened.storage.close();
	}
}

async function commandModels(values: CliValues): Promise<void> {
	const opened = await openStorage(storageOptions(values));
	try {
		const catalog = createModelCatalog({
			isProviderAvailable: storageProviderAvailability(opened.storage),
			providerOrder: providerOrder(),
		});
		const providerFilter = stringValue(values.provider);
		let models = values.all ? catalog.listAll() : catalog.list();
		if (providerFilter) models = models.filter(model => model.provider === providerFilter);

		if (values.json) {
			console.log(
				JSON.stringify(
					models.map(model => ({
						id: `${model.provider}/${model.id}`,
						provider: model.provider,
						model: model.id,
						name: model.name,
						api: model.api,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						input: model.input,
					})),
					null,
					2,
				),
			);
			return;
		}
		if (models.length === 0) {
			console.log("No models. Log in first (`bun run login <provider>`) or pass --all for the full catalog.");
			return;
		}
		printTable(["PROVIDER", "MODEL", "NAME", "CONTEXT", "OUTPUT", "INPUT"], modelRows(models));
		console.log(`\n${models.length} model(s). Use the provider/model id in requests.`);
	} finally {
		opened.storage.close();
	}
}

async function commandHealthcheck(values: CliValues): Promise<void> {
	const bind = stringValue(values.bind) ?? process.env.OMP_BROKER_BIND?.trim() ?? DEFAULT_BIND;
	const host = bindHost(bind);
	const urlHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
	const response = await fetch(`http://${urlHost}:${bindPort(bind)}/healthz`, {
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) throw new Error(`healthcheck failed: ${response.status}`);
	const body = (await response.json()) as { ok?: boolean };
	if (!body.ok) throw new Error("healthcheck failed: not ok");
}

async function commandToken(values: CliValues): Promise<void> {
	const resolved = await resolveToken({
		explicit: stringValue(values.token),
		regenerate: Boolean(values.regenerate),
	});
	if (values.json) {
		console.log(JSON.stringify(resolved, null, 2));
		return;
	}
	console.log(resolved.token);
	if (values.regenerate && resolved.source !== "file") {
		console.error(`note: ${resolved.source} token overrides the regenerated file`);
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		strict: true,
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			bind: { type: "string" },
			token: { type: "string" },
			"no-auth": { type: "boolean" },
			"allow-remote": { type: "boolean" },
			db: { type: "string" },
			omp: { type: "boolean" },
			isolated: { type: "boolean" },
			"agent-dir": { type: "string" },
			manual: { type: "boolean" },
			all: { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			json: { type: "boolean" },
			regenerate: { type: "boolean" },
			provider: { type: "string" },
			budget: { type: "string" },
			period: { type: "string" },
			"request-limit": { type: "string" },
			"allow-model": { type: "string", multiple: true },
			"block-model": { type: "string", multiple: true },
			"allow-ip": { type: "string", multiple: true },
			expires: { type: "string" },
		},
	});

	const typed = values as CliValues;
	if (typed.version) {
		console.log(`omp-broker ${VERSION}`);
		return;
	}
	if (typed.help || positionals.length === 0) {
		printHelp();
		return;
	}

	switch (positionals[0]) {
		case "serve":
			await commandServe(typed);
			return;
		case "login":
			await commandLogin(typed, positionals);
			return;
		case "logout":
			await commandLogout(typed, positionals);
			return;
		case "status":
			await commandStatus(typed);
			return;
		case "providers":
			await commandProviders(typed);
			return;
		case "models":
			await commandModels(typed);
			return;
		case "token":
			await commandToken(typed);
			return;
		case "key":
			await commandKey(typed, positionals);
			return;
		case "healthcheck":
			await commandHealthcheck(typed);
			return;
		default:
			printHelp();
			throw new Error(`Unknown command: ${positionals[0]}`);
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
