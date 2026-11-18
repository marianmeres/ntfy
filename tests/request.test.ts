import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildNtfyRequest,
	encodeHeaderValue,
	MESSAGE_SIZE_LIMIT,
	type NtfyAction,
	NtfyConfigError,
	normalizeDelay,
	normalizePriority,
	normalizeTags,
	resolveTransport,
} from "../src/mod.ts";

function json(body: unknown): Record<string, unknown> {
	return JSON.parse(String(body));
}

test("the default transport is one JSON object POSTed to the server root", () => {
	const r = buildNtfyRequest({ topic: "alerts", message: "hi" });
	assert.deepEqual(r.method, "POST");
	assert.deepEqual(r.url, "https://ntfy.sh/");
	assert.deepEqual(r.transport, "json");
	assert.deepEqual(r.headers["Content-Type"], "application/json");
	assert.deepEqual(json(r.body), { topic: "alerts", message: "hi" });
});

test("a bare string is a message", () => {
	const r = buildNtfyRequest({ topic: "alerts", ...{ message: "hi" } });
	assert.deepEqual(json(r.body).message, "hi");
});

test("every publish field reaches the JSON payload", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "body",
		title: "Title",
		priority: "high",
		tags: ["warning", "skull"],
		click: "https://example.com",
		markdown: true,
		icon: "https://example.com/i.png",
		attach: "https://example.com/f.jpg",
		filename: "f.jpg",
		actions: [{ action: "view", label: "Open", url: "https://example.com" }],
		delay: "30m",
		sequenceId: "seq-1",
	});
	assert.deepEqual(json(r.body), {
		topic: "alerts",
		message: "body",
		title: "Title",
		priority: 4,
		tags: ["warning", "skull"],
		click: "https://example.com",
		markdown: true,
		icon: "https://example.com/i.png",
		attach: "https://example.com/f.jpg",
		filename: "f.jpg",
		actions: [{ action: "view", label: "Open", url: "https://example.com" }],
		delay: "30m",
		sequence_id: "seq-1",
	});
});

test("cache, firebase, email and call reach the JSON payload too", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "body",
		email: "a@example.com",
		call: "yes",
		cache: false,
		firebase: false,
	});
	assert.deepEqual(json(r.body), {
		topic: "alerts",
		message: "body",
		email: "a@example.com",
		call: "yes",
		cache: "no",
		firebase: "no",
	});
});

test("priority accepts numbers and names, and refuses the rest", () => {
	assert.deepEqual(normalizePriority(1), 1);
	assert.deepEqual(normalizePriority("urgent"), 5);
	assert.deepEqual(normalizePriority("MAX"), 5);
	assert.throws(() => normalizePriority(0), NtfyConfigError);
	assert.throws(() => normalizePriority(6), NtfyConfigError);
	assert.throws(() => normalizePriority("loud"), NtfyConfigError);
});

test("tags accept an array or a comma-separated string", () => {
	assert.deepEqual(normalizeTags("a, b ,,c"), ["a", "b", "c"]);
	assert.deepEqual(normalizeTags([" a ", ""]), ["a"]);
	assert.throws(() => normalizeTags(["x".repeat(513)]), {
		name: "NtfyConfigError",
		message: /512/,
	});
});

test("delay: a Date becomes unix seconds, milliseconds are refused", () => {
	assert.deepEqual(normalizeDelay(new Date(1_700_000_000_000)), "1700000000");
	assert.deepEqual(normalizeDelay(1_700_000_000), "1700000000");
	assert.deepEqual(normalizeDelay("tomorrow, 3pm"), "tomorrow, 3pm");
	assert.throws(() => normalizeDelay(Date.now()), {
		name: "NtfyConfigError",
		message: /milliseconds/,
	});
});

test("a token becomes a Bearer header, a user/password pair becomes Basic", () => {
	assert.deepEqual(
		buildNtfyRequest({ topic: "t", token: "tk_x" }).headers["Authorization"],
		"Bearer tk_x",
	);
	assert.deepEqual(
		buildNtfyRequest({ topic: "t", username: "u", password: "p" }).headers[
			"Authorization"
		],
		`Basic ${btoa("u:p")}`,
	);
});

test("basic auth survives a non-ASCII password", () => {
	const header = buildNtfyRequest({ topic: "t", username: "u", password: "häslo" })
		.headers["Authorization"];
	assert.deepEqual(header, "Basic dTpow6RzbG8=");
});

test("auth that cannot be resolved is refused", () => {
	assert.throws(
		() => buildNtfyRequest({ topic: "t", token: "a", username: "u", password: "p" }),
		{ name: "NtfyConfigError", message: /not both/ },
	);
	assert.throws(() => buildNtfyRequest({ topic: "t", username: "u" }), {
		name: "NtfyConfigError",
		message: /both/,
	});
});

test("an uploaded file switches to the body transport and PUTs the bytes", () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "look",
		attachment: bytes,
		filename: "flower.jpg",
	});
	assert.deepEqual(r.transport, "body");
	assert.deepEqual(r.method, "PUT");
	assert.deepEqual(r.url, "https://ntfy.sh/alerts");
	assert.deepEqual(r.body, bytes);
	assert.deepEqual(r.headers["X-Filename"], "flower.jpg");
	assert.deepEqual(r.headers["X-Message"], "look");
});

test("a multi-line message in a header is folded the way ntfy unfolds it", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "one\ntwo",
		attachment: new Uint8Array([0]),
	});
	assert.deepEqual(r.headers["X-Message"], "one\\ntwo");
});

test("without a file the body transport puts the message in the body", () => {
	const r = buildNtfyRequest({ topic: "alerts", message: "hi", transport: "body" });
	assert.deepEqual(r.method, "POST");
	assert.deepEqual(r.url, "https://ntfy.sh/alerts");
	assert.deepEqual(r.body, "hi");
	assert.deepEqual(r.headers["X-Message"], undefined);
	assert.deepEqual(r.headers["Content-Type"], "text/plain; charset=utf-8");
});

test("a non-ASCII title is RFC 2047 encoded for the header transport", () => {
	assert.deepEqual(encodeHeaderValue("plain"), "plain");
	assert.deepEqual(encodeHeaderValue("Ápfel"), "=?UTF-8?B?w4FwZmVs?=");
	const r = buildNtfyRequest({ topic: "t", title: "Ápfel", transport: "body" });
	assert.deepEqual(r.headers["X-Title"], "=?UTF-8?B?w4FwZmVs?=");
});

test("a message over ntfy's text limit switches to the body transport", () => {
	const long = "x".repeat(MESSAGE_SIZE_LIMIT + 1);
	assert.deepEqual(resolveTransport({ message: long }), "body");
	assert.deepEqual(
		resolveTransport({ message: "x".repeat(MESSAGE_SIZE_LIMIT) }),
		"json",
	);
	const r = buildNtfyRequest({ topic: "alerts", message: long });
	assert.deepEqual(r.transport, "body");
	assert.deepEqual(r.body, long);
});

test("transport: json refuses what it cannot carry, saying why", () => {
	assert.throws(
		() =>
			buildNtfyRequest({
				topic: "t",
				transport: "json",
				attachment: new Uint8Array([1]),
			}),
		{ name: "NtfyConfigError", message: /body transport/ },
	);
	assert.throws(
		() =>
			buildNtfyRequest({
				topic: "t",
				transport: "json",
				actions: "view, Open, https://x",
			}),
		{ name: "NtfyConfigError", message: /short-format/ },
	);
	assert.throws(
		() =>
			buildNtfyRequest({
				topic: "t",
				transport: "json",
				message: "x".repeat(MESSAGE_SIZE_LIMIT + 1),
			}),
		{ name: "NtfyConfigError", message: /byte limit/ },
	);
});

test("short-format actions are passed to the server verbatim", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "hi",
		actions: "view, Open, https://example.com",
	});
	assert.deepEqual(r.transport, "body");
	assert.deepEqual(r.headers["X-Actions"], "view, Open, https://example.com");
});

test("structured actions are JSON in the body transport too", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		transport: "body",
		actions: [{ action: "copy", label: "Copy", value: "abc" }],
	});
	assert.deepEqual(
		r.headers["X-Actions"],
		'[{"action":"copy","label":"Copy","value":"abc"}]',
	);
});

test("actions are validated before anything is spent", () => {
	const view = { action: "view", label: "x", url: "https://x" } as const;
	assert.throws(
		() => buildNtfyRequest({ topic: "t", actions: [view, view, view, view] }),
		{ name: "NtfyConfigError", message: /at most 3/ },
	);
	assert.throws(
		() =>
			buildNtfyRequest({
				topic: "t",
				actions: [{ action: "view", label: "", url: "u" }],
			}),
		{ name: "NtfyConfigError", message: /no label/ },
	);
	assert.throws(
		() =>
			buildNtfyRequest({
				topic: "t",
				actions: [{ action: "view", label: "l", url: "" }],
			}),
		{ name: "NtfyConfigError", message: /no url/ },
	);
	assert.throws(
		() =>
			buildNtfyRequest({
				topic: "t",
				actions: [{ action: "nope", label: "l" } as unknown as NtfyAction],
			}),
		{ name: "NtfyConfigError", message: /unknown type/ },
	);
});

test("combinations ntfy rejects are rejected here, before the round trip", () => {
	assert.throws(() => buildNtfyRequest({ topic: "t", delay: "30m", cache: false }), {
		name: "NtfyConfigError",
		message: /cache/,
	});
	assert.throws(() => buildNtfyRequest({ topic: "t", delay: "30m", email: "a@b.c" }), {
		name: "NtfyConfigError",
		message: /e-mail/,
	});
	assert.throws(() => buildNtfyRequest({ topic: "t", delay: "30m", call: "yes" }), {
		name: "NtfyConfigError",
		message: /phone call/,
	});
});

test("icon and attach must be http(s) URLs; a title has a size limit", () => {
	assert.throws(() => buildNtfyRequest({ topic: "t", icon: "file:///tmp/x.png" }), {
		name: "NtfyConfigError",
		message: /http\(s\)/,
	});
	assert.throws(() => buildNtfyRequest({ topic: "t", attach: "not a url" }), {
		name: "NtfyConfigError",
		message: /http\(s\)/,
	});
	assert.throws(() => buildNtfyRequest({ topic: "t", title: "x".repeat(1025) }), {
		name: "NtfyConfigError",
		message: /1024/,
	});
});

test("extra headers are merged last", () => {
	const r = buildNtfyRequest({
		topic: "t",
		headers: {
			"X-Poll-ID": "abc",
			"Content-Type": "application/json; charset=utf-8",
		},
	});
	assert.deepEqual(r.headers["X-Poll-ID"], "abc");
	assert.deepEqual(r.headers["Content-Type"], "application/json; charset=utf-8");
});

test("a missing topic is reported as a topic problem", () => {
	assert.throws(
		() => buildNtfyRequest({ message: "hi" }),
		(e) => {
			assert.ok(e instanceof NtfyConfigError);
			assert.match(String(e), /NTFY_TOPIC/);
			return true;
		},
	);
});

test("a small upload gets a filename so ntfy reads it as an attachment, not as text", () => {
	const small = buildNtfyRequest({ topic: "t", attachment: new Uint8Array([1, 2, 3]) });
	assert.deepEqual(small.headers["X-Filename"], "attachment");

	// Above the text limit ntfy always treats the body as an attachment and names it from the
	// detected content type — better than anything invented here.
	const large = buildNtfyRequest({
		topic: "t",
		attachment: new Uint8Array(MESSAGE_SIZE_LIMIT + 1),
	});
	assert.deepEqual(large.headers["X-Filename"], undefined);

	const named = buildNtfyRequest({
		topic: "t",
		attachment: new Uint8Array([1]),
		filename: "flower.jpg",
	});
	assert.deepEqual(named.headers["X-Filename"], "flower.jpg");
});
