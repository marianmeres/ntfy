import { assertEquals, assertThrows } from "@std/assert";
import { ENV_VARS, NtfyConfigError, optionsFromEnv } from "../src/mod.ts";

function env(vars: Record<string, string>) {
	return (key: string) => vars[key];
}

Deno.test("an empty environment produces empty options, not blanks", () => {
	assertEquals(optionsFromEnv(env({})), {});
});

Deno.test("every documented variable is read", () => {
	const options = optionsFromEnv(env({
		NTFY_TOPIC: "alerts",
		NTFY_SERVER: "https://ntfy.example.com",
		NTFY_TOKEN: "tk_x",
		NTFY_PRIORITY: "high",
		NTFY_TAGS: "robot,warning",
		NTFY_TITLE: "cron",
		NTFY_ICON: "https://example.com/i.png",
		NTFY_CLICK: "https://example.com",
		NTFY_TIMEOUT: "2500",
	}));
	assertEquals(options, {
		topic: "alerts",
		server: "https://ntfy.example.com",
		token: "tk_x",
		priority: 4,
		tags: "robot,warning",
		title: "cron",
		icon: "https://example.com/i.png",
		click: "https://example.com",
		timeout: 2500,
	});
});

Deno.test("basic auth comes from NTFY_USERNAME / NTFY_PASSWORD", () => {
	const options = optionsFromEnv(env({ NTFY_USERNAME: "u", NTFY_PASSWORD: "p" }));
	assertEquals(options, { username: "u", password: "p" });
});

Deno.test("exported-but-empty is the same as unset", () => {
	assertEquals(optionsFromEnv(env({ NTFY_TOPIC: "   ", NTFY_TOKEN: "" })), {});
});

Deno.test("a numeric priority is read as a number", () => {
	assertEquals(optionsFromEnv(env({ NTFY_PRIORITY: "5" })).priority, 5);
});

Deno.test("an unusable variable is a refusal at startup, not a surprise at 4am", () => {
	assertThrows(
		() => optionsFromEnv(env({ NTFY_PRIORITY: "loud" })),
		NtfyConfigError,
		"NTFY_PRIORITY",
	);
	assertThrows(
		() => optionsFromEnv(env({ NTFY_TIMEOUT: "soon" })),
		NtfyConfigError,
		"NTFY_TIMEOUT",
	);
});

Deno.test("ENV_VARS lists exactly what is read", () => {
	assertEquals(ENV_VARS.length, 11);
	assertEquals(ENV_VARS.every((v) => v.startsWith("NTFY_")), true);
});
