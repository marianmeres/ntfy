import { assertEquals, assertThrows } from "@std/assert";
import { jsonUrl, NtfyConfigError, resolveTarget, topicUrl } from "../src/mod.ts";

Deno.test("bare topic goes to ntfy.sh", () => {
	const t = resolveTarget({ topic: "alerts" });
	assertEquals(t, { base: "https://ntfy.sh", topic: "alerts", search: "" });
	assertEquals(jsonUrl(t), "https://ntfy.sh/");
	assertEquals(topicUrl(t), "https://ntfy.sh/alerts");
});

Deno.test("bare topic honours an explicit server", () => {
	const t = resolveTarget({ topic: "alerts", server: "https://ntfy.example.com" });
	assertEquals(t.base, "https://ntfy.example.com");
	assertEquals(topicUrl(t), "https://ntfy.example.com/alerts");
});

Deno.test("host/topic is a target, not a topic", () => {
	const t = resolveTarget({ topic: "ntfy.example.com/alerts" });
	assertEquals(t, { base: "https://ntfy.example.com", topic: "alerts", search: "" });
});

Deno.test("a full URL in `topic` overrides `server`", () => {
	const t = resolveTarget({
		topic: "https://ntfy.example.com/alerts",
		server: "https://ignored.example.com",
	});
	assertEquals(t.base, "https://ntfy.example.com");
	assertEquals(t.topic, "alerts");
});

Deno.test("a server sub-path is kept, and JSON publishing posts to its root", () => {
	const t = resolveTarget({ topic: "https://example.com/ntfy/alerts" });
	assertEquals(t.base, "https://example.com/ntfy");
	assertEquals(t.topic, "alerts");
	assertEquals(jsonUrl(t), "https://example.com/ntfy/");
	assertEquals(topicUrl(t), "https://example.com/ntfy/alerts");
});

Deno.test("?auth= is carried onto both URLs", () => {
	const t = resolveTarget({ topic: "https://ntfy.example.com/alerts?auth=QmFzaWM" });
	assertEquals(t.search, "?auth=QmFzaWM");
	assertEquals(jsonUrl(t), "https://ntfy.example.com/?auth=QmFzaWM");
	assertEquals(topicUrl(t), "https://ntfy.example.com/alerts?auth=QmFzaWM");
});

Deno.test("http:// is honoured, https:// is assumed", () => {
	assertEquals(
		resolveTarget({ topic: "http://localhost:8080/alerts" }).base,
		"http://localhost:8080",
	);
	assertEquals(resolveTarget({ topic: "ntfy.sh/alerts" }).base, "https://ntfy.sh");
});

Deno.test("a server that ends in a topic supplies it", () => {
	const t = resolveTarget({ server: "https://ntfy.example.com/alerts" });
	assertEquals(t.base, "https://ntfy.example.com");
	assertEquals(t.topic, "alerts");
});

Deno.test("trailing slashes do not create an empty topic", () => {
	assertEquals(resolveTarget({ topic: "ntfy.sh/alerts/" }).topic, "alerts");
});

Deno.test("no topic at all is a refusal", () => {
	assertThrows(() => resolveTarget({}), NtfyConfigError, "no topic");
	assertThrows(
		() => resolveTarget({ server: "https://ntfy.sh" }),
		NtfyConfigError,
		"no topic",
	);
});

Deno.test("an invalid topic is a refusal, not a guess", () => {
	assertThrows(() => resolveTarget({ topic: "not a topic" }), NtfyConfigError);
	assertThrows(() => resolveTarget({ topic: "a".repeat(65) }), NtfyConfigError);
	assertThrows(() => resolveTarget({ topic: "ntfy.sh/bad topic" }), NtfyConfigError);
});
