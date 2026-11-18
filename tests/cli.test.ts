import assert from "node:assert/strict";
import { test } from "node:test";
import { type CliIo, runCli } from "../src/cli.ts";

interface Harness {
	io: CliIo;
	out: string[];
	err: string[];
	calls: { url: string; init: RequestInit }[];
	body: () => Record<string, unknown>;
	headers: () => Record<string, string>;
}

type Overrides = Omit<Partial<CliIo>, "env"> & { env?: Record<string, string> };

function harness(overrides: Overrides = {}): Harness {
	const out: string[] = [];
	const err: string[] = [];
	const calls: { url: string; init: RequestInit }[] = [];
	const vars = overrides.env ?? {};

	const fetch = ((input: string | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return Promise.resolve(
			new Response(
				JSON.stringify({
					id: "abc123",
					time: 1,
					event: "message",
					topic: "alerts",
				}),
				{ status: 200 },
			),
		);
	}) as unknown as typeof globalThis.fetch;

	const io: CliIo = {
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		env: (key) => vars[key],
		isStdinTerminal: () => true,
		readStdin: () => Promise.resolve(""),
		fetch,
		...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "env")),
	};

	return {
		io,
		out,
		err,
		calls,
		body: () => JSON.parse(String(calls[0]!.init.body)),
		headers: () => (calls[0]!.init.headers ?? {}) as Record<string, string>,
	};
}

const TOPIC_ENV = { NTFY_TOPIC: "alerts" };

test("--help prints usage and exits 0", async () => {
	const h = harness();
	assert.deepEqual(await runCli(["--help"], h.io), 0);
	assert.match(h.out.join("\n"), /Usage:/);
	assert.deepEqual(h.calls.length, 0);
});

test("the bare command prints help rather than an error", async () => {
	const h = harness();
	assert.deepEqual(await runCli([], h.io), 0);
	assert.match(h.out.join("\n"), /Usage:/);
});

test("--version prints just the version", async () => {
	const h = harness();
	assert.deepEqual(await runCli(["--version"], h.io), 0);
	assert.deepEqual(h.out.length, 1);
	assert.match(h.out[0] ?? "", /\./);
});

test("a message plus NTFY_TOPIC is all it takes", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["backup finished"], h.io), 0);
	assert.deepEqual(h.calls[0]!.url, "https://ntfy.sh/");
	assert.deepEqual(h.body(), { topic: "alerts", message: "backup finished" });
	assert.match(h.out.join("\n"), /sent to https:\/\/ntfy\.sh\//);
	assert.match(h.out.join("\n"), /abc123/);
});

test("positional arguments are joined with spaces", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["backup", "finished", "at", "4am"], h.io);
	assert.deepEqual(h.body().message, "backup finished at 4am");
});

test("flags override the environment", async () => {
	const h = harness({ env: { NTFY_TOPIC: "alerts", NTFY_PRIORITY: "1" } });
	await runCli(["-T", "urgent", "-p", "5", "hi"], h.io);
	assert.deepEqual(h.body(), { topic: "urgent", message: "hi", priority: 5 });
});

test("every message flag reaches the payload", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(
		[
			"-t",
			"Deploy",
			"-p",
			"high",
			"--tags",
			"rocket,white_check_mark",
			"-c",
			"https://example.com",
			"-m",
			"--icon",
			"https://example.com/i.png",
			"--attach",
			"https://example.com/f.jpg",
			"--filename",
			"f.jpg",
			"-d",
			"30m",
			"--sequence-id",
			"seq-1",
			"shipped v1.2.3",
		],
		h.io,
	);
	assert.deepEqual(h.body(), {
		topic: "alerts",
		message: "shipped v1.2.3",
		title: "Deploy",
		priority: 4,
		tags: ["rocket", "white_check_mark"],
		click: "https://example.com",
		markdown: true,
		icon: "https://example.com/i.png",
		attach: "https://example.com/f.jpg",
		filename: "f.jpg",
		delay: "30m",
		sequence_id: "seq-1",
	});
});

test("--no-cache and --no-firebase are negations, not values", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["--no-cache", "--no-firebase", "hi"], h.io);
	assert.deepEqual(h.body().cache, "no");
	assert.deepEqual(h.body().firebase, "no");
});

test("cache and firebase are left alone by default", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["hi"], h.io);
	assert.deepEqual(h.body().cache, undefined);
	assert.deepEqual(h.body().firebase, undefined);
});

test("-k becomes a Bearer token, -u becomes basic auth", async () => {
	const h1 = harness({ env: TOPIC_ENV });
	await runCli(["-k", "tk_secret", "hi"], h1.io);
	assert.deepEqual(h1.headers()["Authorization"], "Bearer tk_secret");

	const h2 = harness({ env: TOPIC_ENV });
	await runCli(["-u", "alice:s3cret", "hi"], h2.io);
	assert.deepEqual(h2.headers()["Authorization"], `Basic ${btoa("alice:s3cret")}`);
});

test("repeated --action flags become one short-format string on the body transport", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(
		[
			"-a",
			"view, Logs, https://ci.example.com/logs",
			"-a",
			"http, Retry, https://ci.example.com/retry, method=POST",
			"build failed",
		],
		h.io,
	);
	assert.deepEqual(h.calls[0]!.url, "https://ntfy.sh/alerts");
	assert.deepEqual(String(h.calls[0]!.init.body), "build failed");
	assert.deepEqual(
		h.headers()["X-Actions"],
		"view, Logs, https://ci.example.com/logs; http, Retry, https://ci.example.com/retry, method=POST",
	);
});

test("piped stdin becomes the message", async () => {
	const h = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => false,
		readStdin: () => Promise.resolve("line one\nline two\n"),
	});
	assert.deepEqual(await runCli([], h.io), 0);
	assert.deepEqual(h.body().message, "line one\nline two");
});

test("typed arguments win over a pipe unless --stdin says otherwise", async () => {
	const typed = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => false,
		readStdin: () => Promise.resolve("piped"),
	});
	await runCli(["typed"], typed.io);
	assert.deepEqual(typed.body().message, "typed");

	const forced = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => true,
		readStdin: () => Promise.resolve("piped"),
	});
	await runCli(["--stdin", "typed"], forced.io);
	assert.deepEqual(forced.body().message, "piped");
});

test("a piped log over 4 KB is sent as an attachment, not rejected", async () => {
	const long = "x".repeat(5000);
	const h = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => false,
		readStdin: () => Promise.resolve(long),
	});
	assert.deepEqual(await runCli([], h.io), 0);
	assert.deepEqual(h.calls[0]!.url, "https://ntfy.sh/alerts");
	assert.deepEqual(String(h.calls[0]!.init.body).length, 5000);
});

test("--file uploads the bytes and names the attachment after the file", async () => {
	const h = harness({
		env: TOPIC_ENV,
		readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
	});
	assert.deepEqual(await runCli(["-f", "/tmp/shot.png", "look"], h.io), 0);
	assert.deepEqual(h.calls[0]!.init.method, "PUT");
	assert.deepEqual(h.headers()["X-Filename"], "shot.png");
	assert.deepEqual(h.headers()["X-Message"], "look");
});

test("--dry-run prints the request and sends nothing", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["-n", "hi"], h.io), 0);
	assert.deepEqual(h.calls.length, 0);
	const printed = h.out.join("\n");
	assert.match(printed, /nothing was sent/);
	assert.match(printed, /POST https:\/\/ntfy\.sh\//);
	assert.match(printed, /"message":"hi"/);
});

test("--dry-run redacts the token it prints", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["-n", "-k", "tk_secret_value_here", "hi"], h.io);
	const printed = h.out.join("\n");
	assert.match(printed, /redacted/);
	assert.deepEqual(printed.includes("tk_secret_value_here"), false);
});

test("-q says nothing on success", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["-q", "hi"], h.io), 0);
	assert.deepEqual(h.out, []);
});

test("a refused message exits 1 and says why", async () => {
	const h = harness({ env: TOPIC_ENV });
	h.io.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ code: 40301, error: "forbidden" }), {
				status: 403,
			}),
		)) as unknown as typeof globalThis.fetch;

	assert.deepEqual(await runCli(["hi"], h.io), 1);
	assert.match(h.err.join("\n"), /HTTP 403/);
	assert.match(h.err.join("\n"), /forbidden/);
});

test("a missing topic exits 2, before anything is sent", async () => {
	const h = harness();
	assert.deepEqual(await runCli(["hi"], h.io), 2);
	assert.deepEqual(h.calls.length, 0);
	assert.match(h.err.join("\n"), /no topic/);
});

test("an unknown option exits 2 and points at --help", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["--nope", "hi"], h.io), 2);
	assert.match(h.err.join("\n"), /Unknown option '--nope'/);
	assert.match(h.err.join("\n"), /--help/);
	assert.deepEqual(h.calls.length, 0);
});

test("an option missing its value exits 2 instead of sending without it", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["hi", "-t"], h.io), 2);
	assert.match(h.err.join("\n"), /'-t, --title <value>' argument missing/);
	assert.deepEqual(h.calls.length, 0);
});

test("a value that starts with a dash has to be spelled with =", async () => {
	const ambiguous = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["-t", "-5 degrees", "hi"], ambiguous.io), 2);
	assert.match(ambiguous.err.join("\n"), /--title=-XYZ/);
	assert.deepEqual(ambiguous.calls.length, 0);

	const spelled = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["--title=-5 degrees", "hi"], spelled.io), 0);
	assert.deepEqual(spelled.body().title, "-5 degrees");
});

test("short flags combine, and a short option takes an attached value", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["-mq", "-p4", "hi"], h.io), 0);
	assert.deepEqual(h.body(), {
		topic: "alerts",
		message: "hi",
		priority: 4,
		markdown: true,
	});
	assert.deepEqual(h.out, []);
});

test("arguments after -- are message words, even when they look like options", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["--", "-5", "degrees", "007"], h.io), 0);
	assert.deepEqual(h.body().message, "-5 degrees 007");
});

test("nothing to send exits 2", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["-t", "title only"], h.io), 2);
	assert.match(h.err.join("\n"), /nothing to send/);
});

test("a bad --priority is a configuration refusal, not a send", async () => {
	const h = harness({ env: TOPIC_ENV });
	assert.deepEqual(await runCli(["-p", "loud", "hi"], h.io), 2);
	assert.deepEqual(h.calls.length, 0);
});

test("--env-file supplies defaults that the real environment overrides", async () => {
	const h = harness({
		env: { NTFY_TOKEN: "from-env" },
		readEnvFile: () => ({ NTFY_TOPIC: "from-file", NTFY_TOKEN: "from-file" }),
	});
	assert.deepEqual(await runCli(["--env-file", "/tmp/.env", "hi"], h.io), 0);
	assert.deepEqual(h.body().topic, "from-file");
	assert.deepEqual(h.headers()["Authorization"], "Bearer from-env");
});

test("-H adds a raw header", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["-H", "X-Poll-ID: abc", "hi"], h.io);
	assert.deepEqual(h.headers()["X-Poll-ID"], "abc");
});

test("--verbose prints the request and the reply", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["-v", "hi"], h.io);
	const printed = h.out.join("\n");
	assert.match(printed, /POST https:\/\/ntfy\.sh\//);
	assert.match(printed, /"id": "abc123"/);
});

test("a missing --env-file is a named refusal, not a confusing 'no topic'", async () => {
	const h = harness({ env: TOPIC_ENV });
	// The default reader is used here on purpose: the check lives in it.
	delete (h.io as { readEnvFile?: unknown }).readEnvFile;
	assert.deepEqual(
		await runCli(["--env-file", "/nope/does/not/exist.env", "hi"], h.io),
		2,
	);
	assert.match(h.err.join("\n"), /--env-file/);
	assert.deepEqual(h.calls.length, 0);
});
