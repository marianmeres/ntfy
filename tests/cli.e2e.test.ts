// End-to-end: spawn the CLI and check the stream contract and exit codes, through the real
// defaults the unit tests inject away — `process.env`, `--env-file`, stdin, the filesystem,
// the global `fetch`. Nothing leaves loopback: every send is a dry run or goes to the local
// assert server.
//
// The CLI runs on Node from source (src/bin.ts, the npm bin). `CLI_RUNTIME=deno` runs
// src/main.ts on Deno instead (`pnpm run test:deno`): the JSR entry, as
// `deno run -A jsr:@marianmeres/ntfy` executes it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { path, runtimeArgv, startAssertServer } from "./_runtime.ts";

const CLI_ARGV = runtimeArgv(path(process.env.CLI_RUNTIME === "deno" ? "../src/main.ts" : "../src/bin.ts"));

/** The caller's environment minus any `NTFY_*`, so a developer's setup cannot leak in. */
const BASE_ENV: Record<string, string | undefined> = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith("NTFY_")),
);

/** Every test runs in its own scratch cwd. */
let cwd: string;
before(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ntfy-e2e-"));
});
after(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/**
 * Run the CLI to completion. Asynchronous on purpose: the assert server answering it lives in
 * another process, but the test's own event loop must keep turning to read the output.
 */
function cli(
	args: string[],
	opts: { env?: Record<string, string>; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
	const started = Date.now();
	const [cmd, ...pre] = CLI_ARGV;
	const child = spawn(cmd, [...pre, ...args], {
		cwd,
		env: { ...BASE_ENV, ...opts.env },
		// Without `input`, stdin is /dev/null: not a TTY, empty.
		stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout!.setEncoding("utf8").on("data", (c: string) => (stdout += c));
	child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
	if (opts.input !== undefined) child.stdin?.end(opts.input);
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) =>
			resolve({ code, stdout, stderr, ms: Date.now() - started }),
		);
	});
}

test("--version prints the package version, exit 0", async () => {
	const pkg = JSON.parse(await readFile(path("../package.json"), "utf8"));
	const r = await cli(["--version"]);
	assert.deepEqual([r.code, r.stdout, r.stderr], [0, `${pkg.version}\n`, ""]);
});

test("--help prints usage, exit 0", async () => {
	const r = await cli(["--help"]);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /Usage:\n {2}mmntfy \[options\] \[message\.\.\.\]/);
});

test("-n: the topic comes from the process environment, nothing is sent", async () => {
	const r = await cli(["-n", "-t", "Deploy", "shipped"], { env: { NTFY_TOPIC: "alerts" } });
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stderr, "");
	assert.match(r.stdout, /^Would send \(nothing was sent\):\nPOST https:\/\/ntfy\.sh\/ {2}\[json\]/);
	assert.match(r.stdout, /"topic":"alerts","message":"shipped","title":"Deploy"/);
});

test("--env-file: read (BOM, export, quotes, comments); the real environment wins", async () => {
	const file = join(cwd, "ntfy.env");
	await writeFile(
		file,
		'﻿NTFY_TOPIC=from-file\nexport NTFY_TITLE="From file" # comment\nNTFY_TOKEN=tk_file\n',
	);
	try {
		const fromFile = await cli(["-n", "--env-file", file, "hi"]);
		assert.equal(fromFile.code, 0, fromFile.stderr);
		assert.match(fromFile.stdout, /"topic":"from-file","message":"hi","title":"From file"/);
		assert.match(fromFile.stdout, /Authorization: Bearer …\(redacted\)/);

		const fromProcess = await cli(["-n", "--env-file", file, "hi"], {
			env: { NTFY_TOPIC: "from-process" },
		});
		assert.match(fromProcess.stdout, /"topic":"from-process"/);
	} finally {
		await rm(file);
	}
});

test("a missing --env-file is a refusal that names the file", async () => {
	const r = await cli(["-n", "--env-file", "nope.env", "hi"], { env: { NTFY_TOPIC: "alerts" } });
	// Node scans the *script's* arguments for `--env-file` too, and exits 9 with
	// "node: nope.env: not found" before the CLI runs (seen on 26.13). It never loads such a
	// file, so an existing one is harmless; only the exit code of a missing one differs from
	// the CLI's own 2, which Deno shows and tests/cli.test.ts covers.
	assert.ok(r.code === 2 || r.code === 9, `exit ${r.code}`);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /nope\.env/);
});

test("piped stdin is the message; a trailing newline is not", async () => {
	const r = await cli(["-n"], { env: { NTFY_TOPIC: "alerts" }, input: "line one\nline two\n" });
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /"message":"line one\\nline two"\}/);
});

test("-f reads the file and names the attachment after it", async () => {
	await writeFile(join(cwd, "shot.png"), new Uint8Array([1, 2, 3]));
	const r = await cli(["-n", "-f", "shot.png", "look"], { env: { NTFY_TOPIC: "alerts" } });
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /^PUT https:\/\/ntfy\.sh\/alerts {2}\[body\]$/m);
	assert.match(r.stdout, /^ {2}X-Filename: shot\.png$/m);
	assert.match(r.stdout, /^<3 bytes of attachment>$/m);
});

test("an unknown option exits 2 with nothing on stdout", async () => {
	const r = await cli(["--nope", "hi"], { env: { NTFY_TOPIC: "alerts" } });
	assert.equal(r.code, 2);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /Unknown option '--nope'/);
	assert.match(r.stderr, /mmntfy --help/);
});

test("a real send through the global fetch: exit 0, and the process ends promptly", async () => {
	const server = await startAssertServer({
		method: "POST",
		path: "/",
		headers: { "Content-Type": "application/json", Authorization: "Bearer tk_e2e" },
		body: JSON.stringify({ topic: "alerts", message: "hello", title: "Ahoj" }),
	});
	try {
		const r = await cli(["-T", `http://127.0.0.1:${server.port}/alerts`, "-t", "Ahoj", "hello"], {
			env: { NTFY_TOKEN: "tk_e2e" },
		});
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout, `sent to http://127.0.0.1:${server.port}/ (id sync123)\n`);
		// `process.exitCode`, not `exit()`: nothing — a keep-alive socket, the timeout timer —
		// may hold the process open after the reply.
		assert.ok(r.ms < 5000, `the CLI took ${r.ms}ms to exit`);
	} finally {
		await server.stop();
	}
});

test("a send the server refuses exits 1 and says why", async () => {
	const server = await startAssertServer({ path: "/never-matches" });
	try {
		const r = await cli(["-T", `http://127.0.0.1:${server.port}/alerts`, "hello"]);
		assert.equal(r.code, 1);
		assert.equal(r.stdout, "");
		assert.match(r.stderr, /^mmntfy: HTTP 400 — path: want \/never-matches, got \/ \(code 40001\)$/m);
	} finally {
		await server.stop();
	}
});
