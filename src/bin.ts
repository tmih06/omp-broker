#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import * as path from "node:path";
import { gatewayHome } from "./config";

// Injected by scripts/build.ts for standalone binaries. Undefined when run
// from source, where pi-natives resolves from node_modules normally.
declare const OMP_NATIVE_VERSION: string;

const nativeVersion = typeof OMP_NATIVE_VERSION === "string" ? OMP_NATIVE_VERSION : undefined;
if (nativeVersion) {
	type EmbeddedFile = Blob & { name: string };
	const addons = Bun.embeddedFiles.filter(file =>
		(file as EmbeddedFile).name.endsWith(".node"),
	) as EmbeddedFile[];
	if (addons.length > 0) {
		const configured = process.env.PI_NATIVES_DIR?.trim();
		const base =
			configured && path.isAbsolute(configured) ? configured : path.join(gatewayHome(), "natives");
		const targetDir = path.join(base, nativeVersion);
		for (const addon of addons) {
			const target = path.join(targetDir, addon.name);
			if (existsSync(target)) continue;
			await mkdir(targetDir, { recursive: true, mode: 0o700 });
			const temp = `${target}.${process.pid}.tmp`;
			await Bun.write(temp, addon);
			await rename(temp, target);
		}
		process.env.PI_NATIVES_DIR = base;
	}
}

// Must be dynamic: a static import would evaluate pi-ai (and pi-natives)
// before the embedded addon is extracted above.
await import("./cli");
