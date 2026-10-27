import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { DEFAULT_PROVIDER_ORDER } from "./config";

export interface ModelCatalogOptions {
	/** Override the bundled catalog (tests, custom deployments). */
	models?: readonly Model<Api>[];
	/** Reports whether a provider has a usable credential (stored or env). */
	isProviderAvailable?: (provider: string) => boolean;
	providerOrder?: readonly string[];
}

export interface ModelCatalog {
	/** Resolve a bare model id or `provider/model`. */
	resolve(modelId: string): Model<Api> | undefined;
	/** Models from providers with credentials, in provider-preference order. */
	list(): Model<Api>[];
	/** Every known chat model, credential or not. */
	listAll(): Model<Api>[];
	/** Providers with credentials that expose at least one model. */
	providers(): string[];
}

/**
 * A provider is usable when it has a stored credential or an env/native auth
 * source. `credentials.has()` is the cheap in-memory check; `keys.source()`
 * covers env vars without touching the network.
 */
export function storageProviderAvailability(storage: AuthStorage): (provider: string) => boolean {
	return provider => {
		if (storage.credentials.has(provider)) return true;
		try {
			return storage.keys.source(provider) !== undefined;
		} catch {
			return false;
		}
	};
}

export function collectBundledChatModels(): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider)) {
			if (modelKind(model) === "chat") models.push(model);
		}
	}
	return models;
}

export function createModelCatalog(options: ModelCatalogOptions = {}): ModelCatalog {
	const ordered = [
		...(options.providerOrder ?? []),
		...DEFAULT_PROVIDER_ORDER,
	];
	const rank = new Map<string, number>();
	for (const provider of ordered) if (!rank.has(provider)) rank.set(provider, rank.size);

	const all = options.models ?? collectBundledChatModels();
	const byId = new Map<string, Model<Api>[]>();
	const byKey = new Map<string, Model<Api>>();
	const byProvider = new Map<string, Model<Api>[]>();
	const lowerIds = new Map<string, string[]>();

	for (const model of all) {
		if (modelKind(model) !== "chat") continue;
		const key = `${model.provider}\u0000${model.id}`;
		byKey.set(key, model);

		const sameId = byId.get(model.id);
		if (sameId) sameId.push(model);
		else byId.set(model.id, [model]);

		const providerModels = byProvider.get(model.provider);
		if (providerModels) providerModels.push(model);
		else byProvider.set(model.provider, [model]);

		const lower = model.id.toLowerCase();
		const spellings = lowerIds.get(lower);
		if (spellings) {
			if (!spellings.includes(model.id)) spellings.push(model.id);
		} else {
			lowerIds.set(lower, [model.id]);
		}
	}

	// Rank providers that were absent from the configured order.
	for (const provider of [...byProvider.keys()].sort()) {
		if (!rank.has(provider)) rank.set(provider, rank.size);
	}

	const isAvailable = options.isProviderAvailable ?? (() => true);
	const sortModels = (models: readonly Model<Api>[]): Model<Api>[] =>
		[...models].sort(
			(a, b) =>
				(rank.get(a.provider) ?? Number.MAX_SAFE_INTEGER) -
					(rank.get(b.provider) ?? Number.MAX_SAFE_INTEGER) ||
				a.provider.localeCompare(b.provider) ||
				a.id.localeCompare(b.id),
		);

	const resolveCandidates = (modelId: string): Model<Api>[] | undefined => {
		const exact = byId.get(modelId);
		if (exact) return exact;
		const canonical = lowerIds.get(modelId.toLowerCase());
		if (!canonical) return undefined;
		const matches: Model<Api>[] = [];
		for (const id of canonical) matches.push(...(byId.get(id) ?? []));
		return matches.length > 0 ? matches : undefined;
	};

	return {
		resolve(modelId) {
			const trimmed = modelId.trim();
			if (!trimmed) return undefined;

			const slash = trimmed.indexOf("/");
			if (slash > 0) {
				const provider = trimmed.slice(0, slash);
				if (byProvider.has(provider)) {
					const qualified = byKey.get(`${provider}\u0000${trimmed.slice(slash + 1)}`);
					if (qualified) return qualified;
					// Fall through: `provider/<rest>` can also be a bare model id
					// from a gateway provider (e.g. OpenRouter's `anthropic/...`).
				}
			}

			const candidates = resolveCandidates(trimmed);
			if (!candidates) return undefined;
			const available = candidates.filter(model => isAvailable(model.provider));
			// A known model on an unauthenticated provider is still returned so
			// the gateway answers "no credential for <provider>" (401) rather
			// than "unknown model" (404).
			return sortModels(available.length > 0 ? available : [...candidates])[0];
		},
		list() {
			const models: Model<Api>[] = [];
			for (const provider of [...byProvider.keys()].sort(
				(a, b) =>
					(rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
					a.localeCompare(b),
			)) {
				if (isAvailable(provider)) models.push(...(byProvider.get(provider) ?? []));
			}
			return models;
		},
		listAll() {
			return sortModels(all);
		},
		providers() {
			return [...byProvider.keys()]
				.filter(provider => isAvailable(provider))
				.sort(
					(a, b) =>
						(rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
						a.localeCompare(b),
				);
		},
	};
}
