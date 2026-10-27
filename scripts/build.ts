#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.join(root, "dist");
const binary = path.join(dist, "omp-broker");
const assetDir = path.join(dist, ".native");

/**
 * pi-ai eagerly loads the pi-natives N-API addon, and a compiled Bun binary
 * cannot resolve it from node_modules. Embed the zstd-compressed platform
 * addon and extract it into the broker cache on first run (src/bin.ts sets
 * PI_NATIVES_DIR before importing the CLI).
 */
const tag = `${process.platform}-${process.arch}`;
const require = createRequire(import.meta.url);
let nativeDir: string;
try {
	nativeDir = path.dirname(require.resolve(`@oh-my-pi/pi-natives-${tag}`));
} catch {
	throw new Error(`Missing @oh-my-pi/pi-natives-${tag}. Install dependencies on the target platform before building.`);
}
const addons = readdirSync(nativeDir).filter(file => file.endsWith(".node"));
if (addons.length === 0) throw new Error(`No .node addon found in ${nativeDir}`);
const nativeVersion = JSON.parse(readFileSync(path.join(nativeDir, "package.json"), "utf8")).version as string;

mkdirSync(assetDir, { recursive: true });
const assets: string[] = [];
for (const addon of addons) {
	const source = path.join(nativeDir, addon);
	const compressed = path.join(assetDir, `${addon}.zst`);
	const started = performance.now();
	const sourceBytes = readFileSync(source);
	const compressedBytes = Bun.zstdCompressSync(sourceBytes, { level: 19 });
	writeFileSync(compressed, compressedBytes);
	assets.push(compressed);
	console.log(
		`compressed ${addon}: ${(sourceBytes.byteLength / 1e6).toFixed(1)} MB -> ` +
			`${(compressedBytes.byteLength / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - started)} ms`,
	);
}

const args = [
	"bun",
	"build",
	"--compile",
	"--target=bun",
	"--minify",
	// Bun AOT bytecode + dead-runtime trimming. Accepted since 1.4.4; Linux
	// trimming is still conservative, so the compressed addon carries most of
	// the size win today.
	"--aot",
	"--trim",
	"--sourcemap=none",
	"--no-compile-autoload-dotenv",
	"--no-compile-autoload-bunfig",
	"--no-compile-autoload-tsconfig",
	"--no-compile-autoload-package-json",
	"--define",
	`OMP_NATIVE_VERSION=${JSON.stringify(nativeVersion)}`,
];
for (const asset of assets) args.push("--asset", asset);
args.push("./src/bin.ts", "--outfile", binary);

const build = Bun.spawnSync({ cmd: args, cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
rmSync(assetDir, { recursive: true, force: true });

console.log(`\nBuilt ${binary} (${(readFileSync(binary).byteLength / 1e6).toFixed(1)} MB)`);
console.log(`Embedded pi_natives ${nativeVersion} (${addons.join(", ")})`);
console.log("First run extracts the addon into $OMP_BROKER_HOME/natives.");
