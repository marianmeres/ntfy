import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
	createNtfy,
	createNtfySend,
	ntfy,
	NtfyConfigError,
	NtfyError,
	type NtfyOptions,
	ntfySend,
} from "../src/mod.ts";

/** A `fetch` that records what it was asked to do and answers however the test wants. */
function recordingFetch(response: () => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return Promise.resolve(response());
	};
	return { calls, fetch: fn as unknown as typeof globalThis.fetch };
}

function published(extra: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			id: "abc123",
			time: 1,
			event: "message",
			topic: "alerts",
			...extra,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Nothing in this suite may log; a silenced logger is how that is proven. */
const quiet: NtfyOptions = { logger: false };

Deno.test("a successful send reports ok and the server's echo", async () => {
	const { calls, fetch } = recordingFetch(() => published());
	const result = await ntfySend({ ...quiet, topic: "alerts", message: "hi", fetch });

	assertEquals(result.ok, true);
	assertEquals(result.status, 200);
	assertEquals(result.message?.id, "abc123");
	assertEquals(calls.length, 1);
	assertEquals(calls[0].url, "https://ntfy.sh/");
	assertEquals(calls[0].init.method, "POST");
	assertEquals(JSON.parse(String(calls[0].init.body)), {
		topic: "alerts",
		message: "hi",
	});
});

Deno.test("ntfy() is the same thing, reduced to a boolean", async () => {
	const { fetch } = recordingFetch(() => published());
	assertEquals(await ntfy({ ...quiet, topic: "alerts", message: "hi", fetch }), true);
});

Deno.test("a refusal is reported with ntfy's own reason and code", async () => {
	const { fetch } = recordingFetch(() =>
		new Response(
			JSON.stringify({ code: 40301, http: 403, error: "forbidden" }),
			{ status: 403 },
		)
	);
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });

	assertEquals(result.ok, false);
	assertEquals(result.status, 403);
	assertEquals(result.errorCode, 40301);
	assertStringIncludes(result.error!, "HTTP 403");
	assertStringIncludes(result.error!, "forbidden");
	assertStringIncludes(result.error!, "40301");
});

Deno.test("a non-JSON error body is still reported, not swallowed", async () => {
	const { fetch } = recordingFetch(() =>
		new Response("<html>502 Bad Gateway</html>", { status: 502 })
	);
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });
	assertEquals(result.ok, false);
	assertStringIncludes(result.error!, "HTTP 502");
});

Deno.test("a network failure is a failure, not a throw", async () => {
	const fetch = (() =>
		Promise.reject(
			new Error("connection refused"),
		)) as unknown as typeof globalThis.fetch;
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });
	assertEquals(result.ok, false);
	assertEquals(result.status, 0);
	assertStringIncludes(result.error!, "connection refused");
});

Deno.test("throwOnError turns a refusal into an NtfyError carrying the status", async () => {
	const { fetch } = recordingFetch(() =>
		new Response(JSON.stringify({ code: 40301, error: "forbidden" }), { status: 403 })
	);
	const error = await assertRejects(
		() => ntfySend({ ...quiet, topic: "alerts", fetch, throwOnError: true }),
		NtfyError,
	);
	assertEquals(error.status, 403);
	assertEquals(error.code, 40301);
	assertEquals(error.url, "https://ntfy.sh/");
});

Deno.test("a config error is returned by default and thrown on request", async () => {
	const result = await ntfySend({ ...quiet, message: "no topic here" });
	assertEquals(result.ok, false);
	assertEquals(result.status, 0);
	assertStringIncludes(result.error!, "no topic");

	await assertRejects(
		() => ntfySend({ ...quiet, message: "no topic here", throwOnError: true }),
		NtfyConfigError,
	);
});

Deno.test("a failure is logged, so silence never means success by accident", async () => {
	const warnings: string[] = [];
	const fetch =
		(() =>
			Promise.reject(new Error("offline"))) as unknown as typeof globalThis.fetch;
	await ntfySend({
		topic: "alerts",
		fetch,
		logger: { warn: (...a) => warnings.push(a.join(" ")), error: () => {} },
	});
	assertEquals(warnings.length, 1);
	assertStringIncludes(warnings[0], "offline");
});

Deno.test("a timeout aborts the request and says so", async () => {
	const fetch =
		((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
				);
			})) as unknown as typeof globalThis.fetch;

	const result = await ntfySend({ ...quiet, topic: "alerts", fetch, timeout: 20 });
	assertEquals(result.ok, false);
	assertStringIncludes(result.error!, "timed out after 20ms");
});

Deno.test("a caller's abort signal is honoured alongside the timeout", async () => {
	const controller = new AbortController();
	const fetch =
		((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
				);
			})) as unknown as typeof globalThis.fetch;

	const pending = ntfySend({
		...quiet,
		topic: "alerts",
		fetch,
		signal: controller.signal,
	});
	controller.abort();
	const result = await pending;
	assertEquals(result.ok, false);
	assertStringIncludes(result.error!, "aborted");
});

Deno.test("dryRun validates and returns the request without sending", async () => {
	const { calls, fetch } = recordingFetch(() => published());
	const result = await ntfySend({
		...quiet,
		topic: "alerts",
		message: "hi",
		fetch,
		dryRun: true,
	});
	assertEquals(calls.length, 0);
	assertEquals(result.ok, true);
	assertEquals(result.dryRun, true);
	assertEquals(result.request?.url, "https://ntfy.sh/");
});

Deno.test("dryRun still refuses what could never be sent", async () => {
	const result = await ntfySend({ ...quiet, message: "hi", dryRun: true });
	assertEquals(result.ok, false);
	assertStringIncludes(result.error!, "no topic");
});

Deno.test("createNtfy binds defaults, per-call options win", async () => {
	const { calls, fetch } = recordingFetch(() => published());
	const notify = createNtfy({ ...quiet, topic: "alerts", tags: ["robot"], fetch });

	assertEquals(await notify("backup finished"), true);
	assertEquals(JSON.parse(String(calls[0].init.body)), {
		topic: "alerts",
		message: "backup finished",
		tags: ["robot"],
	});

	await notify({ message: "backup failed", priority: 5, topic: "urgent" });
	assertEquals(JSON.parse(String(calls[1].init.body)), {
		topic: "urgent",
		message: "backup failed",
		priority: 5,
		tags: ["robot"],
	});
});

Deno.test("createNtfySend reports the full result", async () => {
	const { fetch } = recordingFetch(() => published());
	const send = createNtfySend({ ...quiet, topic: "alerts", fetch });
	const result = await send("hi");
	assertEquals(result.message?.id, "abc123");
});

Deno.test("a delivered message with an unparsable body is still delivered", async () => {
	const { fetch } = recordingFetch(() => new Response("ok", { status: 200 }));
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });
	assertEquals(result.ok, true);
	assertEquals(result.message, undefined);
});
