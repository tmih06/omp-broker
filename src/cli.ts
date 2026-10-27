#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { OAuthLoginIdentity } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthAuthInfo, OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	DEFAULT_BIND,
	VERSION,
	isLoopbackBind,
	resolveToken,
	providerOrder,
} from "./config";
import {
	credentialRows,
	listLoginProviders,
	loginProvider,
	removeProvider,
	storedProviders,
} from "./credentials";
import { createModelCatalog, storageProviderAvailability } from "./models";
import { Prompter } from "./prompt";
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
}

function printHelp(): void {
	console.log(`omp-gateway v${VERSION} — OpenAI/Anthropic-compatible API for omp subscription logins

USAGE
  omp-gateway <command> [options]

COMMANDS
  serve                 Start the gateway (default ${DEFAULT_BIND})
  login <provider>      Log in with OAuth or an API key and store the credential
  logout [provider]     Remove stored credentials (--all removes every provider)
  status                Show stored credentials
  providers             Show providers available for login
  models                List models served by authenticated providers
  token                 Print the gateway bearer token

OPTIONS
  --bind <host:port>    Listen address (env: OMP_GATEWAY_BIND)
  --token <token>       Use this bearer instead of the token file
  --no-auth             Disable bearer auth (loopback binds only)
  --allow-remote        Permit --no-auth on a non-loopback bind
  --db <path>           Use an isolated SQLite credential store
  --omp                  Force the omp credential store (default)
  --isolated            Use ~/.omp-gateway/auth.db
  --agent-dir <path>    omp profile agent directory
  --manual              Login: also accept a pasted redirect URL or code
  --all                 Logout: remove every provider
  --yes, -y             Skip the logout confirmation
  --json                Machine-readable output
  --regenerate          Token: replace the token file
  -h, --help            Show this help
  -v, --version         Show the version

ENDPOINTS
  POST /v1/chat/completions    OpenAI chat-completions
  POST /v1/messages            Anthropic Messages
  POST /v1/responses           OpenAI Responses
  GET  /v1/models              Models with credentials
  GET  /v1/usage               Provider quota/usage
  GET  /healthz                Liveness

EXAMPLES
  bun run login openai-codex
  bun run login anthropic --manual
  bun run start --bind=0.0.0.0:4000
  curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer $(bun run token)"`);
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
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
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
	const bind = stringValue(values.bind) ?? process.env.OMP_GATEWAY_BIND?.trim() ?? DEFAULT_BIND;
	const noAuth = Boolean(values["no-auth"]);
	if (noAuth && !isLoopbackBind(bind) && !values["allow-remote"]) {
		throw new Error(
			`Refusing --no-auth on non-loopback bind ${bind}. Pass --allow-remote if the network exposure is intentional.`,
		);
	}

	const opened = await openStorage(storageOptions(values));
	let bearerTokens: string[] = [];
	let authLabel = "disabled (--no-auth)";
	if (!noAuth) {
		const resolved = await resolveToken({ explicit: stringValue(values.token) });
		bearerTokens = [resolved.token];
		authLabel =
			resolved.source === "file" ? `bearer token ${resolved.path}` : `bearer token from ${resolved.source}`;
	}

	const running = await startGateway({
		storage: opened.storage,
		bearerTokens,
		bind,
		providerOrder: providerOrder(),
	});
	const providers = running.catalog.providers();
	const modelCount = running.catalog.list().length;

	console.log(`omp-gateway v${VERSION} listening on ${running.url}`);
	console.log(`storage:   ${opened.label}`);
	console.log(`auth:      ${authLabel}`);
	console.log(
		`providers: ${providers.length > 0 ? providers.join(", ") : "(none — run `bun run login <provider>`)"}`,
	);
	console.log(`models:    ${modelCount}`);
	console.log("endpoints: POST /v1/chat/completions, POST /v1/messages, POST /v1/responses");
	console.log("           GET /v1/models, GET /v1/usage, GET /healthz");

	if (noAuth) console.warn("warning: the gateway accepts unauthenticated requests");
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
		opened.storage.close();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
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
			throw new Error("Usage: omp-gateway login <provider>");
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
		if (!provider) throw new Error("Usage: omp-gateway logout <provider> (or --all)");
		const existed = await removeProvider(opened.storage, provider);
		console.log(
			existed ? `Removed stored credentials for ${provider}.` : `No stored credentials for ${provider}.`,
		);
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
		printTable(
			["PROVIDER", "MODEL", "NAME", "CONTEXT", "OUTPUT", "INPUT"],
			modelRows(models),
		);
		console.log(`\n${models.length} model(s). Use the provider/model id in requests.`);
	} finally {
		opened.storage.close();
	}
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
		},
	});

	const typed = values as CliValues;
	if (typed.version) {
		console.log(`omp-gateway ${VERSION}`);
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
		default:
			printHelp();
			throw new Error(`Unknown command: ${positionals[0]}`);
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
