import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonUrl, NtfyConfigError, resolveTarget, topicUrl } from "../src/mod.ts";

test("bare topic goes to ntfy.sh", () => {
	const t = resolveTarget({ topic: "alerts" });
	assert.deepEqual(t, { base: "https://ntfy.sh", topic: "alerts", search: "" });
	assert.deepEqual(jsonUrl(t), "https://ntfy.sh/");
	assert.deepEqual(topicUrl(t), "https://ntfy.sh/alerts");
});

test("bare topic honours an explicit server", () => {
	const t = resolveTarget({ topic: "alerts", server: "https://ntfy.example.com" });
	assert.deepEqual(t.base, "https://ntfy.example.com");
	assert.deepEqual(topicUrl(t), "https://ntfy.example.com/alerts");
});

test("host/topic is a target, not a topic", () => {
	const t = resolveTarget({ topic: "ntfy.example.com/alerts" });
	assert.deepEqual(t, { base: "https://ntfy.example.com", topic: "alerts", search: "" });
});

test("a full URL in `topic` overrides `server`", () => {
	const t = resolveTarget({
		topic: "https://ntfy.example.com/alerts",
		server: "https://ignored.example.com",
	});
	assert.deepEqual(t.base, "https://ntfy.example.com");
	assert.deepEqual(t.topic, "alerts");
});

test("a server sub-path is kept, and JSON publishing posts to its root", () => {
	const t = resolveTarget({ topic: "https://example.com/ntfy/alerts" });
	assert.deepEqual(t.base, "https://example.com/ntfy");
	assert.deepEqual(t.topic, "alerts");
	assert.deepEqual(jsonUrl(t), "https://example.com/ntfy/");
	assert.deepEqual(topicUrl(t), "https://example.com/ntfy/alerts");
});

test("?auth= is carried onto both URLs", () => {
	const t = resolveTarget({ topic: "https://ntfy.example.com/alerts?auth=QmFzaWM" });
	assert.deepEqual(t.search, "?auth=QmFzaWM");
	assert.deepEqual(jsonUrl(t), "https://ntfy.example.com/?auth=QmFzaWM");
	assert.deepEqual(topicUrl(t), "https://ntfy.example.com/alerts?auth=QmFzaWM");
});

test("http:// is honoured, https:// is assumed", () => {
	assert.deepEqual(
		resolveTarget({ topic: "http://localhost:8080/alerts" }).base,
		"http://localhost:8080",
	);
	assert.deepEqual(resolveTarget({ topic: "ntfy.sh/alerts" }).base, "https://ntfy.sh");
});

test("a server that ends in a topic supplies it", () => {
	const t = resolveTarget({ server: "https://ntfy.example.com/alerts" });
	assert.deepEqual(t.base, "https://ntfy.example.com");
	assert.deepEqual(t.topic, "alerts");
});

test("trailing slashes do not create an empty topic", () => {
	assert.deepEqual(resolveTarget({ topic: "ntfy.sh/alerts/" }).topic, "alerts");
});

test("no topic at all is a refusal", () => {
	assert.throws(() => resolveTarget({}), { name: "NtfyConfigError", message: /no topic/ });
	assert.throws(() => resolveTarget({ server: "https://ntfy.sh" }), { name: "NtfyConfigError", message: /no topic/ });
});

test("an invalid topic is a refusal, not a guess", () => {
	assert.throws(() => resolveTarget({ topic: "not a topic" }), NtfyConfigError);
	assert.throws(() => resolveTarget({ topic: "a".repeat(65) }), NtfyConfigError);
	assert.throws(() => resolveTarget({ topic: "ntfy.sh/bad topic" }), NtfyConfigError);
});
