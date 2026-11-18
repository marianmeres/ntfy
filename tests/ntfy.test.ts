import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createNtfy,
	createNtfySend,
	NtfyConfigError,
	NtfyError,
	type NtfyOptions,
	ntfy,
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

test("a successful send reports ok and the server's echo", async () => {
	const { calls, fetch } = recordingFetch(() => published());
	const result = await ntfySend({ ...quiet, topic: "alerts", message: "hi", fetch });

	assert.deepEqual(result.ok, true);
	assert.deepEqual(result.status, 200);
	assert.deepEqual(result.message?.id, "abc123");
	assert.deepEqual(calls.length, 1);
	assert.deepEqual(calls[0]!.url, "https://ntfy.sh/");
	assert.deepEqual(calls[0]!.init.method, "POST");
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		topic: "alerts",
		message: "hi",
	});
});

test("ntfy() is the same thing, reduced to a boolean", async () => {
	const { fetch } = recordingFetch(() => published());
	assert.deepEqual(
		await ntfy({ ...quiet, topic: "alerts", message: "hi", fetch }),
		true,
	);
});

test("a refusal is reported with ntfy's own reason and code", async () => {
	const { fetch } = recordingFetch(
		() =>
			new Response(JSON.stringify({ code: 40301, http: 403, error: "forbidden" }), {
				status: 403,
			}),
	);
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });

	assert.deepEqual(result.ok, false);
	assert.deepEqual(result.status, 403);
	assert.deepEqual(result.errorCode, 40301);
	assert.match(result.error!, /HTTP 403/);
	assert.match(result.error!, /forbidden/);
	assert.match(result.error!, /40301/);
});

test("a non-JSON error body is still reported, not swallowed", async () => {
	const { fetch } = recordingFetch(
		() => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
	);
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /HTTP 502/);
});

test("a network failure is a failure, not a throw", async () => {
	const fetch = (() =>
		Promise.reject(
			new Error("connection refused"),
		)) as unknown as typeof globalThis.fetch;
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });
	assert.deepEqual(result.ok, false);
	assert.deepEqual(result.status, 0);
	assert.match(result.error!, /connection refused/);
});

test("throwOnError turns a refusal into an NtfyError carrying the status", async () => {
	const { fetch } = recordingFetch(
		() =>
			new Response(JSON.stringify({ code: 40301, error: "forbidden" }), {
				status: 403,
			}),
	);
	await assert.rejects(
		() => ntfySend({ ...quiet, topic: "alerts", fetch, throwOnError: true }),
		(error) => {
			assert.ok(error instanceof NtfyError);
			assert.deepEqual(error.status, 403);
			assert.deepEqual(error.code, 40301);
			assert.deepEqual(error.url, "https://ntfy.sh/");
			return true;
		},
	);
});

test("a config error is returned by default and thrown on request", async () => {
	const result = await ntfySend({ ...quiet, message: "no topic here" });
	assert.deepEqual(result.ok, false);
	assert.deepEqual(result.status, 0);
	assert.match(result.error!, /no topic/);

	await assert.rejects(
		() => ntfySend({ ...quiet, message: "no topic here", throwOnError: true }),
		NtfyConfigError,
	);
});

test("a failure is logged, so silence never means success by accident", async () => {
	const warnings: string[] = [];
	const fetch = (() =>
		Promise.reject(new Error("offline"))) as unknown as typeof globalThis.fetch;
	await ntfySend({
		topic: "alerts",
		fetch,
		logger: { warn: (...a) => warnings.push(a.join(" ")), error: () => {} },
	});
	assert.deepEqual(warnings.length, 1);
	assert.match(warnings[0] ?? "", /offline/);
});

test("a timeout aborts the request and says so", async () => {
	const fetch = ((_url: string, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		})) as unknown as typeof globalThis.fetch;

	const result = await ntfySend({ ...quiet, topic: "alerts", fetch, timeout: 20 });
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /timed out after 20ms/);
});

test("a caller's abort signal is honoured alongside the timeout", async () => {
	const controller = new AbortController();
	const fetch = ((_url: string, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		})) as unknown as typeof globalThis.fetch;

	const pending = ntfySend({
		...quiet,
		topic: "alerts",
		fetch,
		signal: controller.signal,
	});
	controller.abort();
	const result = await pending;
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /aborted/);
});

test("dryRun validates and returns the request without sending", async () => {
	const { calls, fetch } = recordingFetch(() => published());
	const result = await ntfySend({
		...quiet,
		topic: "alerts",
		message: "hi",
		fetch,
		dryRun: true,
	});
	assert.deepEqual(calls.length, 0);
	assert.deepEqual(result.ok, true);
	assert.deepEqual(result.dryRun, true);
	assert.deepEqual(result.request?.url, "https://ntfy.sh/");
});

test("dryRun still refuses what could never be sent", async () => {
	const result = await ntfySend({ ...quiet, message: "hi", dryRun: true });
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /no topic/);
});

test("createNtfy binds defaults, per-call options win", async () => {
	const { calls, fetch } = recordingFetch(() => published());
	const notify = createNtfy({ ...quiet, topic: "alerts", tags: ["robot"], fetch });

	assert.deepEqual(await notify("backup finished"), true);
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		topic: "alerts",
		message: "backup finished",
		tags: ["robot"],
	});

	await notify({ message: "backup failed", priority: 5, topic: "urgent" });
	assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
		topic: "urgent",
		message: "backup failed",
		priority: 5,
		tags: ["robot"],
	});
});

test("createNtfySend reports the full result", async () => {
	const { fetch } = recordingFetch(() => published());
	const send = createNtfySend({ ...quiet, topic: "alerts", fetch });
	const result = await send("hi");
	assert.deepEqual(result.message?.id, "abc123");
});

test("a delivered message with an unparsable body is still delivered", async () => {
	const { fetch } = recordingFetch(() => new Response("ok", { status: 200 }));
	const result = await ntfySend({ ...quiet, topic: "alerts", fetch });
	assert.deepEqual(result.ok, true);
	assert.deepEqual(result.message, undefined);
});
