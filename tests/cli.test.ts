import { assertEquals, assertStringIncludes } from "@std/assert";
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
		body: () => JSON.parse(String(calls[0].init.body)),
		headers: () => (calls[0].init.headers ?? {}) as Record<string, string>,
	};
}

const TOPIC_ENV = { NTFY_TOPIC: "alerts" };

Deno.test("--help prints usage and exits 0", async () => {
	const h = harness();
	assertEquals(await runCli(["--help"], h.io), 0);
	assertStringIncludes(h.out.join("\n"), "Usage:");
	assertEquals(h.calls.length, 0);
});

Deno.test("the bare command prints help rather than an error", async () => {
	const h = harness();
	assertEquals(await runCli([], h.io), 0);
	assertStringIncludes(h.out.join("\n"), "Usage:");
});

Deno.test("--version prints just the version", async () => {
	const h = harness();
	assertEquals(await runCli(["--version"], h.io), 0);
	assertEquals(h.out.length, 1);
	assertStringIncludes(h.out[0], ".");
});

Deno.test("a message plus NTFY_TOPIC is all it takes", async () => {
	const h = harness({ env: TOPIC_ENV });
	assertEquals(await runCli(["backup finished"], h.io), 0);
	assertEquals(h.calls[0].url, "https://ntfy.sh/");
	assertEquals(h.body(), { topic: "alerts", message: "backup finished" });
	assertStringIncludes(h.out.join("\n"), "sent to https://ntfy.sh/");
	assertStringIncludes(h.out.join("\n"), "abc123");
});

Deno.test("positional arguments are joined with spaces", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["backup", "finished", "at", "4am"], h.io);
	assertEquals(h.body().message, "backup finished at 4am");
});

Deno.test("flags override the environment", async () => {
	const h = harness({ env: { NTFY_TOPIC: "alerts", NTFY_PRIORITY: "1" } });
	await runCli(["-T", "urgent", "-p", "5", "hi"], h.io);
	assertEquals(h.body(), { topic: "urgent", message: "hi", priority: 5 });
});

Deno.test("every message flag reaches the payload", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli([
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
	], h.io);
	assertEquals(h.body(), {
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

Deno.test("--no-cache and --no-firebase are negations, not values", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["--no-cache", "--no-firebase", "hi"], h.io);
	assertEquals(h.body().cache, "no");
	assertEquals(h.body().firebase, "no");
});

Deno.test("cache and firebase are left alone by default", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["hi"], h.io);
	assertEquals(h.body().cache, undefined);
	assertEquals(h.body().firebase, undefined);
});

Deno.test("-k becomes a Bearer token, -u becomes basic auth", async () => {
	const h1 = harness({ env: TOPIC_ENV });
	await runCli(["-k", "tk_secret", "hi"], h1.io);
	assertEquals(h1.headers()["Authorization"], "Bearer tk_secret");

	const h2 = harness({ env: TOPIC_ENV });
	await runCli(["-u", "alice:s3cret", "hi"], h2.io);
	assertEquals(h2.headers()["Authorization"], `Basic ${btoa("alice:s3cret")}`);
});

Deno.test("repeated --action flags become one short-format string on the body transport", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli([
		"-a",
		"view, Logs, https://ci.example.com/logs",
		"-a",
		"http, Retry, https://ci.example.com/retry, method=POST",
		"build failed",
	], h.io);
	assertEquals(h.calls[0].url, "https://ntfy.sh/alerts");
	assertEquals(String(h.calls[0].init.body), "build failed");
	assertEquals(
		h.headers()["X-Actions"],
		"view, Logs, https://ci.example.com/logs; http, Retry, https://ci.example.com/retry, method=POST",
	);
});

Deno.test("piped stdin becomes the message", async () => {
	const h = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => false,
		readStdin: () => Promise.resolve("line one\nline two\n"),
	});
	assertEquals(await runCli([], h.io), 0);
	assertEquals(h.body().message, "line one\nline two");
});

Deno.test("typed arguments win over a pipe unless --stdin says otherwise", async () => {
	const typed = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => false,
		readStdin: () => Promise.resolve("piped"),
	});
	await runCli(["typed"], typed.io);
	assertEquals(typed.body().message, "typed");

	const forced = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => true,
		readStdin: () => Promise.resolve("piped"),
	});
	await runCli(["--stdin", "typed"], forced.io);
	assertEquals(forced.body().message, "piped");
});

Deno.test("a piped log over 4 KB is sent as an attachment, not rejected", async () => {
	const long = "x".repeat(5000);
	const h = harness({
		env: TOPIC_ENV,
		isStdinTerminal: () => false,
		readStdin: () => Promise.resolve(long),
	});
	assertEquals(await runCli([], h.io), 0);
	assertEquals(h.calls[0].url, "https://ntfy.sh/alerts");
	assertEquals(String(h.calls[0].init.body).length, 5000);
});

Deno.test("--file uploads the bytes and names the attachment after the file", async () => {
	const h = harness({
		env: TOPIC_ENV,
		readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
	});
	assertEquals(await runCli(["-f", "/tmp/shot.png", "look"], h.io), 0);
	assertEquals(h.calls[0].init.method, "PUT");
	assertEquals(h.headers()["X-Filename"], "shot.png");
	assertEquals(h.headers()["X-Message"], "look");
});

Deno.test("--dry-run prints the request and sends nothing", async () => {
	const h = harness({ env: TOPIC_ENV });
	assertEquals(await runCli(["-n", "hi"], h.io), 0);
	assertEquals(h.calls.length, 0);
	const printed = h.out.join("\n");
	assertStringIncludes(printed, "nothing was sent");
	assertStringIncludes(printed, "POST https://ntfy.sh/");
	assertStringIncludes(printed, '"message":"hi"');
});

Deno.test("--dry-run redacts the token it prints", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["-n", "-k", "tk_secret_value_here", "hi"], h.io);
	const printed = h.out.join("\n");
	assertStringIncludes(printed, "redacted");
	assertEquals(printed.includes("tk_secret_value_here"), false);
});

Deno.test("-q says nothing on success", async () => {
	const h = harness({ env: TOPIC_ENV });
	assertEquals(await runCli(["-q", "hi"], h.io), 0);
	assertEquals(h.out, []);
});

Deno.test("a refused message exits 1 and says why", async () => {
	const h = harness({ env: TOPIC_ENV });
	h.io.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ code: 40301, error: "forbidden" }), {
				status: 403,
			}),
		)) as unknown as typeof globalThis.fetch;

	assertEquals(await runCli(["hi"], h.io), 1);
	assertStringIncludes(h.err.join("\n"), "HTTP 403");
	assertStringIncludes(h.err.join("\n"), "forbidden");
});

Deno.test("a missing topic exits 2, before anything is sent", async () => {
	const h = harness();
	assertEquals(await runCli(["hi"], h.io), 2);
	assertEquals(h.calls.length, 0);
	assertStringIncludes(h.err.join("\n"), "no topic");
});

Deno.test("an unknown option exits 2 and points at --help", async () => {
	const h = harness({ env: TOPIC_ENV });
	assertEquals(await runCli(["--nope", "hi"], h.io), 2);
	assertStringIncludes(h.err.join("\n"), "unknown option: --nope");
	assertStringIncludes(h.err.join("\n"), "--help");
});

Deno.test("nothing to send exits 2", async () => {
	const h = harness({ env: TOPIC_ENV });
	assertEquals(await runCli(["-t", "title only"], h.io), 2);
	assertStringIncludes(h.err.join("\n"), "nothing to send");
});

Deno.test("a bad --priority is a configuration refusal, not a send", async () => {
	const h = harness({ env: TOPIC_ENV });
	assertEquals(await runCli(["-p", "loud", "hi"], h.io), 2);
	assertEquals(h.calls.length, 0);
});

Deno.test("--env-file supplies defaults that the real environment overrides", async () => {
	const h = harness({
		env: { NTFY_TOKEN: "from-env" },
		readEnvFile: () => ({ NTFY_TOPIC: "from-file", NTFY_TOKEN: "from-file" }),
	});
	assertEquals(await runCli(["--env-file", "/tmp/.env", "hi"], h.io), 0);
	assertEquals(h.body().topic, "from-file");
	assertEquals(h.headers()["Authorization"], "Bearer from-env");
});

Deno.test("-H adds a raw header", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["-H", "X-Poll-ID: abc", "hi"], h.io);
	assertEquals(h.headers()["X-Poll-ID"], "abc");
});

Deno.test("--verbose prints the request and the reply", async () => {
	const h = harness({ env: TOPIC_ENV });
	await runCli(["-v", "hi"], h.io);
	const printed = h.out.join("\n");
	assertStringIncludes(printed, "POST https://ntfy.sh/");
	assertStringIncludes(printed, '"id": "abc123"');
});

Deno.test("a missing --env-file is a named refusal, not a confusing 'no topic'", async () => {
	const h = harness({ env: TOPIC_ENV });
	// The default reader is used here on purpose: the check lives in it.
	delete (h.io as { readEnvFile?: unknown }).readEnvFile;
	assertEquals(await runCli(["--env-file", "/nope/does/not/exist.env", "hi"], h.io), 2);
	assertStringIncludes(h.err.join("\n"), "--env-file");
	assertEquals(h.calls.length, 0);
});
