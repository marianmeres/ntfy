import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
	buildNtfyRequest,
	encodeHeaderValue,
	MESSAGE_SIZE_LIMIT,
	normalizeDelay,
	normalizePriority,
	normalizeTags,
	NtfyConfigError,
	resolveTransport,
} from "../src/mod.ts";

function json(body: unknown): Record<string, unknown> {
	return JSON.parse(String(body));
}

Deno.test("the default transport is one JSON object POSTed to the server root", () => {
	const r = buildNtfyRequest({ topic: "alerts", message: "hi" });
	assertEquals(r.method, "POST");
	assertEquals(r.url, "https://ntfy.sh/");
	assertEquals(r.transport, "json");
	assertEquals(r.headers["Content-Type"], "application/json");
	assertEquals(json(r.body), { topic: "alerts", message: "hi" });
});

Deno.test("a bare string is a message", () => {
	const r = buildNtfyRequest({ topic: "alerts", ...{ message: "hi" } });
	assertEquals(json(r.body).message, "hi");
});

Deno.test("every publish field reaches the JSON payload", () => {
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
	assertEquals(json(r.body), {
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

Deno.test("cache, firebase, email and call reach the JSON payload too", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "body",
		email: "a@example.com",
		call: "yes",
		cache: false,
		firebase: false,
	});
	assertEquals(json(r.body), {
		topic: "alerts",
		message: "body",
		email: "a@example.com",
		call: "yes",
		cache: "no",
		firebase: "no",
	});
});

Deno.test("priority accepts numbers and names, and refuses the rest", () => {
	assertEquals(normalizePriority(1), 1);
	assertEquals(normalizePriority("urgent"), 5);
	assertEquals(normalizePriority("MAX"), 5);
	assertThrows(() => normalizePriority(0), NtfyConfigError);
	assertThrows(() => normalizePriority(6), NtfyConfigError);
	assertThrows(() => normalizePriority("loud"), NtfyConfigError);
});

Deno.test("tags accept an array or a comma-separated string", () => {
	assertEquals(normalizeTags("a, b ,,c"), ["a", "b", "c"]);
	assertEquals(normalizeTags([" a ", ""]), ["a"]);
	assertThrows(() => normalizeTags(["x".repeat(513)]), NtfyConfigError, "512");
});

Deno.test("delay: a Date becomes unix seconds, milliseconds are refused", () => {
	assertEquals(normalizeDelay(new Date(1_700_000_000_000)), "1700000000");
	assertEquals(normalizeDelay(1_700_000_000), "1700000000");
	assertEquals(normalizeDelay("tomorrow, 3pm"), "tomorrow, 3pm");
	assertThrows(() => normalizeDelay(Date.now()), NtfyConfigError, "milliseconds");
});

Deno.test("a token becomes a Bearer header, a user/password pair becomes Basic", () => {
	assertEquals(
		buildNtfyRequest({ topic: "t", token: "tk_x" }).headers["Authorization"],
		"Bearer tk_x",
	);
	assertEquals(
		buildNtfyRequest({ topic: "t", username: "u", password: "p" })
			.headers["Authorization"],
		`Basic ${btoa("u:p")}`,
	);
});

Deno.test("basic auth survives a non-ASCII password", () => {
	const header = buildNtfyRequest({ topic: "t", username: "u", password: "häslo" })
		.headers["Authorization"];
	assertEquals(header, "Basic dTpow6RzbG8=");
});

Deno.test("auth that cannot be resolved is refused", () => {
	assertThrows(
		() => buildNtfyRequest({ topic: "t", token: "a", username: "u", password: "p" }),
		NtfyConfigError,
		"not both",
	);
	assertThrows(
		() => buildNtfyRequest({ topic: "t", username: "u" }),
		NtfyConfigError,
		"both",
	);
});

Deno.test("an uploaded file switches to the body transport and PUTs the bytes", () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "look",
		attachment: bytes,
		filename: "flower.jpg",
	});
	assertEquals(r.transport, "body");
	assertEquals(r.method, "PUT");
	assertEquals(r.url, "https://ntfy.sh/alerts");
	assertEquals(r.body, bytes);
	assertEquals(r.headers["X-Filename"], "flower.jpg");
	assertEquals(r.headers["X-Message"], "look");
});

Deno.test("a multi-line message in a header is folded the way ntfy unfolds it", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "one\ntwo",
		attachment: new Uint8Array([0]),
	});
	assertEquals(r.headers["X-Message"], "one\\ntwo");
});

Deno.test("without a file the body transport puts the message in the body", () => {
	const r = buildNtfyRequest({ topic: "alerts", message: "hi", transport: "body" });
	assertEquals(r.method, "POST");
	assertEquals(r.url, "https://ntfy.sh/alerts");
	assertEquals(r.body, "hi");
	assertEquals(r.headers["X-Message"], undefined);
	assertEquals(r.headers["Content-Type"], "text/plain; charset=utf-8");
});

Deno.test("a non-ASCII title is RFC 2047 encoded for the header transport", () => {
	assertEquals(encodeHeaderValue("plain"), "plain");
	assertEquals(encodeHeaderValue("Ápfel"), "=?UTF-8?B?w4FwZmVs?=");
	const r = buildNtfyRequest({ topic: "t", title: "Ápfel", transport: "body" });
	assertEquals(r.headers["X-Title"], "=?UTF-8?B?w4FwZmVs?=");
});

Deno.test("a message over ntfy's text limit switches to the body transport", () => {
	const long = "x".repeat(MESSAGE_SIZE_LIMIT + 1);
	assertEquals(resolveTransport({ message: long }), "body");
	assertEquals(resolveTransport({ message: "x".repeat(MESSAGE_SIZE_LIMIT) }), "json");
	const r = buildNtfyRequest({ topic: "alerts", message: long });
	assertEquals(r.transport, "body");
	assertEquals(r.body, long);
});

Deno.test("transport: json refuses what it cannot carry, saying why", () => {
	assertThrows(
		() =>
			buildNtfyRequest({
				topic: "t",
				transport: "json",
				attachment: new Uint8Array([1]),
			}),
		NtfyConfigError,
		"body transport",
	);
	assertThrows(
		() =>
			buildNtfyRequest({
				topic: "t",
				transport: "json",
				actions: "view, Open, https://x",
			}),
		NtfyConfigError,
		"short-format",
	);
	assertThrows(
		() =>
			buildNtfyRequest({
				topic: "t",
				transport: "json",
				message: "x".repeat(MESSAGE_SIZE_LIMIT + 1),
			}),
		NtfyConfigError,
		"byte limit",
	);
});

Deno.test("short-format actions are passed to the server verbatim", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		message: "hi",
		actions: "view, Open, https://example.com",
	});
	assertEquals(r.transport, "body");
	assertEquals(r.headers["X-Actions"], "view, Open, https://example.com");
});

Deno.test("structured actions are JSON in the body transport too", () => {
	const r = buildNtfyRequest({
		topic: "alerts",
		transport: "body",
		actions: [{ action: "copy", label: "Copy", value: "abc" }],
	});
	assertEquals(
		r.headers["X-Actions"],
		'[{"action":"copy","label":"Copy","value":"abc"}]',
	);
});

Deno.test("actions are validated before anything is spent", () => {
	const view = { action: "view", label: "x", url: "https://x" } as const;
	assertThrows(
		() => buildNtfyRequest({ topic: "t", actions: [view, view, view, view] }),
		NtfyConfigError,
		"at most 3",
	);
	assertThrows(
		() =>
			buildNtfyRequest({
				topic: "t",
				actions: [{ action: "view", label: "", url: "u" }],
			}),
		NtfyConfigError,
		"no label",
	);
	assertThrows(
		() =>
			buildNtfyRequest({
				topic: "t",
				actions: [{ action: "view", label: "l", url: "" }],
			}),
		NtfyConfigError,
		"no url",
	);
	assertThrows(
		() =>
			buildNtfyRequest({
				topic: "t",
				// deno-lint-ignore no-explicit-any
				actions: [{ action: "nope", label: "l" } as any],
			}),
		NtfyConfigError,
		"unknown type",
	);
});

Deno.test("combinations ntfy rejects are rejected here, before the round trip", () => {
	assertThrows(
		() => buildNtfyRequest({ topic: "t", delay: "30m", cache: false }),
		NtfyConfigError,
		"cache",
	);
	assertThrows(
		() => buildNtfyRequest({ topic: "t", delay: "30m", email: "a@b.c" }),
		NtfyConfigError,
		"e-mail",
	);
	assertThrows(
		() => buildNtfyRequest({ topic: "t", delay: "30m", call: "yes" }),
		NtfyConfigError,
		"phone call",
	);
});

Deno.test("icon and attach must be http(s) URLs; a title has a size limit", () => {
	assertThrows(
		() => buildNtfyRequest({ topic: "t", icon: "file:///tmp/x.png" }),
		NtfyConfigError,
		"http(s)",
	);
	assertThrows(
		() => buildNtfyRequest({ topic: "t", attach: "not a url" }),
		NtfyConfigError,
		"http(s)",
	);
	assertThrows(
		() => buildNtfyRequest({ topic: "t", title: "x".repeat(1025) }),
		NtfyConfigError,
		"1024",
	);
});

Deno.test("extra headers are merged last", () => {
	const r = buildNtfyRequest({
		topic: "t",
		headers: {
			"X-Poll-ID": "abc",
			"Content-Type": "application/json; charset=utf-8",
		},
	});
	assertEquals(r.headers["X-Poll-ID"], "abc");
	assertEquals(r.headers["Content-Type"], "application/json; charset=utf-8");
});

Deno.test("a missing topic is reported as a topic problem", () => {
	const e = assertThrows(() => buildNtfyRequest({ message: "hi" }), NtfyConfigError);
	assertStringIncludes(String(e), "NTFY_TOPIC");
});

Deno.test("a small upload gets a filename so ntfy reads it as an attachment, not as text", () => {
	const small = buildNtfyRequest({ topic: "t", attachment: new Uint8Array([1, 2, 3]) });
	assertEquals(small.headers["X-Filename"], "attachment");

	// Above the text limit ntfy always treats the body as an attachment and names it from the
	// detected content type — better than anything invented here.
	const large = buildNtfyRequest({
		topic: "t",
		attachment: new Uint8Array(MESSAGE_SIZE_LIMIT + 1),
	});
	assertEquals(large.headers["X-Filename"], undefined);

	const named = buildNtfyRequest({
		topic: "t",
		attachment: new Uint8Array([1]),
		filename: "flower.jpg",
	});
	assertEquals(named.headers["X-Filename"], "flower.jpg");
});
