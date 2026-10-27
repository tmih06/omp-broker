#!/usr/bin/env bun
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const binary = path.join(root, "dist", "omp-gateway");

/**
 * pi-ai eagerly loads the pi-natives N-API addon, and a compiled Bun binary
 * cannot resolve it from node_modules. Embed the platform addon and extract it
 * into the gateway cache on first run (src/bin.ts sets PI_NATIVES_DIR before
 * importing the CLI).
 */
const tag = `${process.platform}-${process.arch}`;
const require = createRequire(import.meta.url);
let nativeDir: string;
try {
	nativeDir = path.dirname(require.resolve(`@oh-my-pi/pi-natives-${tag}`));
} catch {
	throw new Error(
		`Missing @oh-my-pi/pi-natives-${tag}. Install dependencies on the target platform before building.`,
	);
}
const addons = readdirSync(nativeDir).filter(file => file.endsWith(".node"));
if (addons.length === 0) throw new Error(`No .node addon found in ${nativeDir}`);
const nativeVersion = JSON.parse(readFileSync(path.join(nativeDir, "package.json"), "utf8")).version as string;

const result = await Bun.build({
	entrypoints: [path.join(root, "src/bin.ts")],
	target: "bun",
	define: { OMP_NATIVE_VERSION: JSON.stringify(nativeVersion) },
	compile: {
		outfile: binary,
		assets: addons.map(addon => path.join(nativeDir, addon)),
	},
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

console.log(`\nBuilt ${binary}`);
console.log(`Embedded pi_natives ${nativeVersion} (${addons.join(", ")})`);
console.log("First run extracts the addon into $OMP_GATEWAY_HOME/natives.");
