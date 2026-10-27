#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import * as path from "node:path";
import { brokerHome } from "./config";

// Injected by scripts/build.ts for standalone binaries. Undefined when run
// from source, where pi-natives resolves from node_modules normally.
declare const OMP_NATIVE_VERSION: string;

const nativeVersion = typeof OMP_NATIVE_VERSION === "string" ? OMP_NATIVE_VERSION : undefined;
if (nativeVersion) {
	type EmbeddedFile = Blob & { name: string };
	const addons = Bun.embeddedFiles.filter(file => {
		const name = (file as EmbeddedFile).name;
		return name.endsWith(".node") || name.endsWith(".node.zst");
	}) as EmbeddedFile[];
	if (addons.length > 0) {
		const configured = process.env.PI_NATIVES_DIR?.trim();
		const base = configured && path.isAbsolute(configured) ? configured : path.join(brokerHome(), "natives");
		const targetDir = path.join(base, nativeVersion);
		for (const addon of addons) {
			const compressed = addon.name.endsWith(".zst");
			const filename = compressed ? addon.name.slice(0, -4) : addon.name;
			const target = path.join(targetDir, filename);
			if (existsSync(target)) continue;
			await mkdir(targetDir, { recursive: true, mode: 0o700 });
			const temp = `${target}.${process.pid}.tmp`;
			const data = compressed ? Bun.zstdDecompressSync(await addon.arrayBuffer()) : addon;
			await Bun.write(temp, data);
			await rename(temp, target);
		}
		process.env.PI_NATIVES_DIR = base;
	}
}

// Must be dynamic: a static import would evaluate pi-ai (and pi-natives)
// before the embedded addon is extracted above.
await import("./cli");
