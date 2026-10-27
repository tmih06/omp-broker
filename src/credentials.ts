import type { AuthStorage, StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition, PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";

export interface CredentialRow {
	id: number;
	provider: string;
	type: "oauth" | "api_key";
	identity: string;
	expiresAt?: number;
}

export interface LoginProviderRow {
	id: string;
	storeAs: string;
	name: string;
	available: boolean;
	stored: boolean;
	hasOAuth: boolean;
}

export function loginProvider(id: string) {
	const definition = getProviderDefinition(id);
	if (!definition?.login) throw new Error(`Unknown or non-login provider: ${id}`);
	return definition;
}

export function listLoginProviders(storage: AuthStorage): LoginProviderRow[] {
	return PROVIDER_REGISTRY.filter(definition => definition.login && definition.showInLoginList !== false).map(
		definition => {
			const storeAs = definition.storeCredentialsAs ?? definition.id;
			return {
				id: definition.id,
				storeAs,
				name: definition.name,
				available: definition.available !== false,
				stored: storage.credentials.has(storeAs),
				hasOAuth: storage.credentials.hasOAuth(storeAs),
			};
		},
	);
}

function redactKey(key: string): string {
	if (!key || key === "N/A" || key.startsWith("<")) return "api key (native)";
	return key.length <= 4 ? "api key …" : `api key …${key.slice(-4)}`;
}

function oauthIdentity(credential: {
	email?: string;
	accountId?: string;
	projectId?: string;
	orgName?: string;
}): string {
	const identity = credential.email ?? credential.accountId ?? credential.orgName ?? credential.projectId;
	return identity || "(oauth)";
}

export function credentialRows(storage: AuthStorage): CredentialRow[] {
	return storage.credentials.list().map((row: StoredAuthCredential) => {
		const credential = row.credential;
		if (credential.type === "oauth") {
			return {
				id: row.id,
				provider: row.provider,
				type: "oauth",
				identity: oauthIdentity(credential),
				expiresAt: credential.expires,
			};
		}
		return {
			id: row.id,
			provider: row.provider,
			type: "api_key",
			identity: redactKey(credential.key),
		};
	});
}

export function storedProviders(storage: AuthStorage): string[] {
	return [...new Set(storage.credentials.list().map(row => row.provider))].sort();
}

export async function removeProvider(storage: AuthStorage, provider: string): Promise<boolean> {
	const stored = getProviderDefinition(provider)?.storeCredentialsAs ?? provider;
	const existed = storage.credentials.has(stored);
	await storage.credentials.remove(stored);
	return existed;
}
