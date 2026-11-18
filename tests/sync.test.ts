import assert from "node:assert/strict";
import { test } from "node:test";
import { haveCurl, ntfySendSync, ntfySync } from "../src/main.ts";
import { startAssertServer as startServer } from "./_runtime.ts";

const curl = haveCurl();

test("ntfySync sends a well-formed request, blocking, through curl", { skip: !curl }, async () => {
	const { port, stop } = await startServer({
		method: "POST",
		path: "/",
		headers: {
			"Content-Type": "application/json",
			"Authorization": "Bearer tk_test",
		},
		body: JSON.stringify({ topic: "alerts", message: "hello", title: "Ahoj" }),
	});
	try {
		const ok = ntfySync({
			server: `http://127.0.0.1:${port}`,
			topic: "alerts",
			message: "hello",
			title: "Ahoj",
			token: "tk_test",
			timeout: 5000,
			logger: false,
		});
		assert.deepEqual(ok, true);
	} finally {
		await stop();
	}
});

test("ntfySync reports the server's own refusal rather than claiming success", { skip: !curl }, async () => {
	const { port, stop } = await startServer({ path: "/never-matches" });
	try {
		const result = ntfySendSync({
			server: `http://127.0.0.1:${port}`,
			topic: "alerts",
			message: "hello",
			timeout: 5000,
			logger: false,
		});
		assert.deepEqual(result.ok, false);
		assert.match(result.error!, /curl exit 22/);
	} finally {
		await stop();
	}
});

test("ntfySync reports an unreachable server instead of hanging", { skip: !curl }, () => {
	// Port 1 on loopback: nothing listens, and the connection is refused immediately.
	const result = ntfySendSync({
		server: "http://127.0.0.1:1",
		topic: "alerts",
		message: "hello",
		timeout: 3000,
		logger: false,
	});
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /curl exit/);
});

test("ntfySync refuses an upload rather than pretending to send it", () => {
	const result = ntfySendSync({
		topic: "alerts",
		attachment: new Uint8Array([1, 2, 3]),
		logger: false,
	});
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /cannot upload a file/);
});

test("ntfySync validates before it spends anything", () => {
	const result = ntfySendSync({ message: "no topic", logger: false });
	assert.deepEqual(result.ok, false);
	assert.match(result.error!, /no topic/);
});

test("ntfySync honours dryRun", () => {
	const result = ntfySendSync({
		topic: "alerts",
		message: "hi",
		dryRun: true,
		logger: false,
	});
	assert.deepEqual(result.ok, true);
	assert.deepEqual(result.dryRun, true);
	assert.deepEqual(result.request?.url, "https://ntfy.sh/");
});

test("haveCurl answers before a run commits to notifying", () => {
	assert.deepEqual(typeof haveCurl(), "boolean");
});
