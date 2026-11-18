/**
 * Smoke-tests the built npm package (`pnpm run smoke`, or `node scripts/smoke-npm.ts` after
 * `pnpm run build`).
 *
 * `pnpm pack`s the repo root - the tarball `pnpm publish` would upload - and in a throw-away
 * project under the OS temp dir installs it with npm, as a consumer gets it, then on Node:
 *
 *  1. checks the installed package.json (the `.` and `./sync` exports and their files, the
 *     `mmntfy` bin, `@marianmeres/clog` as a runtime dependency, `engines.node`), that the
 *     tarball carries `dist/` without the JSR-only `main.js` and without any repo-only
 *     directory, and that the `.` export's module graph imports no `node:*` builtin - the
 *     core is the browser-safe part;
 *  2. runs the installed `mmntfy` bin: `--version`, and a `--dry-run` - the suite runs
 *     `src/*.ts`, so only here does the CLI run from `dist/*.js`, through npm's bin link;
 *  3. imports both exports and builds a request through each, without sending.
 *
 * Repo tool, Node only (nothing here is shipped).
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = "@marianmeres/ntfy";
const BIN = "mmntfy";

/** Repo directories the published tarball must not carry. */
const REPO_ONLY = ["src", "tests", "scripts", "tmp", "node_modules"];

/** Step 3: a library consumer. */
const LIBRARY = `
import assert from "node:assert/strict";
import { buildNtfyRequest, ntfySend } from "${PKG}";
import { haveCurl, ntfySendSync } from "${PKG}/sync";

const r = await ntfySend({ topic: "alerts", message: "hi", dryRun: true });
assert.equal(r.ok, true);
assert.equal(r.request?.url, "https://ntfy.sh/");
assert.equal(buildNtfyRequest({ topic: "ntfy.example.com/alerts" }).url, "https://ntfy.example.com/");

const s = ntfySendSync({ topic: "alerts", message: "hi", dryRun: true });
assert.equal(s.ok, true);
assert.equal(typeof haveCurl(), "boolean");
console.log("smoke: both exports import and build a request");
`;

type Manifest = {
	name?: string;
	version?: string;
	exports?: Record<string, Record<string, string>>;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	engines?: Record<string, string>;
};

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
	console.log(`smoke: $ ${[cmd, ...args].join(" ")}`);
	return execFileSync(cmd, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function check(condition: unknown, what: string): asserts condition {
	if (!condition) throw new Error(`smoke: ${what}`);
}

/** Every module reachable from `entry` by relative import; fails on any `node:*` import. */
function checkBrowserSafe(entry: string): number {
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const [, spec] of source.matchAll(
			/(?:import|export)[^"']*?from\s*["']([^"']+)["']/g,
		)) {
			check(spec, `unparsable import in ${file}`);
			check(
				!spec.startsWith("node:"),
				`${file} imports ${spec}: the core must stay browser-safe`,
			);
			if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
		}
	};
	visit(entry);
	return seen.size;
}

function checkInstalledManifest(dir: string): Manifest {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
	check(pkg.name === PKG, `installed package is "${pkg.name}", expected "${PKG}"`);
	const exportKeys = Object.keys(pkg.exports ?? {});
	check(
		JSON.stringify(exportKeys) === JSON.stringify([".", "./sync"]),
		`exports keys are ${JSON.stringify(exportKeys)}`,
	);
	for (const key of exportKeys) {
		for (const kind of ["types", "default"]) {
			const file = pkg.exports?.[key]?.[kind];
			check(
				file && existsSync(join(dir, file)),
				`exports["${key}"].${kind} does not exist: ${file}`,
			);
		}
	}
	const bin = pkg.bin?.[BIN];
	check(bin && existsSync(join(dir, bin)), `bin "${BIN}" does not exist: ${bin}`);
	check(
		typeof pkg.dependencies?.["@marianmeres/clog"] === "string",
		`@marianmeres/clog is not a runtime dependency: ${JSON.stringify(pkg.dependencies)}`,
	);
	check(typeof pkg.engines?.node === "string", "engines.node missing");
	check(
		!existsSync(join(dir, "dist", "main.js")),
		"the tarball carries the JSR-only main.js",
	);
	for (const name of REPO_ONLY) {
		check(!existsSync(join(dir, name)), `the tarball carries "${name}/"`);
	}
	const core = pkg.exports?.["."]?.default;
	check(core, `exports["."].default missing`);
	const modules = checkBrowserSafe(join(dir, core));
	console.log(
		`smoke: ${pkg.name}@${pkg.version} - bin ${BIN}, @marianmeres/clog ` +
			`${pkg.dependencies?.["@marianmeres/clog"]}, engines.node ${pkg.engines?.node}, ` +
			`"." graph: ${modules} modules, no node:*`,
	);
	return pkg;
}

check(
	["mod.js", "sync.js", "bin.js"].every((f) => existsSync(join(ROOT, "dist", f))),
	"dist/ is missing - run `pnpm run build` first",
);

const project = mkdtempSync(join(tmpdir(), "ntfy-npm-smoke-"));
try {
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "ntfy-npm-smoke", private: true, type: "module" }),
	);
	const packDir = join(project, "pack");
	mkdirSync(packDir);
	run("pnpm", ["pack", "--pack-destination", packDir], ROOT);
	const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
	const [tarball] = tarballs;
	check(
		tarballs.length === 1 && tarball,
		`expected one tarball, got ${JSON.stringify(tarballs)}`,
	);

	run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			join(packDir, tarball),
		],
		project,
	);
	const pkg = checkInstalledManifest(join(project, "node_modules", PKG));

	// The bin, as `npx @marianmeres/ntfy` / an installed `mmntfy` runs it. No NTFY_* from
	// the caller, so the topic is a flag.
	const bin = join(project, "node_modules", ".bin", BIN);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("NTFY_")),
	);
	const version = run(bin, ["--version"], project, env).trim();
	check(
		version === pkg.version,
		`--version printed "${version}", expected "${pkg.version}"`,
	);
	const dry = run(bin, ["-n", "-T", "alerts", "hi"], project, env);
	check(
		dry.startsWith(
			"Would send (nothing was sent):\nPOST https://ntfy.sh/  [json]\n",
		) && dry.includes(`{"topic":"alerts","message":"hi"}`),
		`--dry-run printed ${JSON.stringify(dry)}`,
	);
	console.log("smoke: the bin runs from dist/ (--version, --dry-run)");

	writeFileSync(join(project, "library.mjs"), LIBRARY);
	process.stdout.write(run(process.execPath, ["library.mjs"], project));
	console.log("smoke: OK");
} finally {
	rmSync(project, { recursive: true, force: true });
}
