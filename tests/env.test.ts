import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV_VARS, optionsFromEnv } from "../src/mod.ts";

function env(vars: Record<string, string>) {
	return (key: string) => vars[key];
}

test("an empty environment produces empty options, not blanks", () => {
	assert.deepEqual(optionsFromEnv(env({})), {});
});

test("every documented variable is read", () => {
	const options = optionsFromEnv(
		env({
			NTFY_TOPIC: "alerts",
			NTFY_SERVER: "https://ntfy.example.com",
			NTFY_TOKEN: "tk_x",
			NTFY_PRIORITY: "high",
			NTFY_TAGS: "robot,warning",
			NTFY_TITLE: "cron",
			NTFY_ICON: "https://example.com/i.png",
			NTFY_CLICK: "https://example.com",
			NTFY_TIMEOUT: "2500",
		}),
	);
	assert.deepEqual(options, {
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

test("basic auth comes from NTFY_USERNAME / NTFY_PASSWORD", () => {
	const options = optionsFromEnv(env({ NTFY_USERNAME: "u", NTFY_PASSWORD: "p" }));
	assert.deepEqual(options, { username: "u", password: "p" });
});

test("exported-but-empty is the same as unset", () => {
	assert.deepEqual(optionsFromEnv(env({ NTFY_TOPIC: "   ", NTFY_TOKEN: "" })), {});
});

test("a numeric priority is read as a number", () => {
	assert.deepEqual(optionsFromEnv(env({ NTFY_PRIORITY: "5" })).priority, 5);
});

test("an unusable variable is a refusal at startup, not a surprise at 4am", () => {
	assert.throws(() => optionsFromEnv(env({ NTFY_PRIORITY: "loud" })), {
		name: "NtfyConfigError",
		message: /NTFY_PRIORITY/,
	});
	assert.throws(() => optionsFromEnv(env({ NTFY_TIMEOUT: "soon" })), {
		name: "NtfyConfigError",
		message: /NTFY_TIMEOUT/,
	});
});

test("ENV_VARS lists exactly what is read", () => {
	assert.deepEqual(ENV_VARS.length, 11);
	assert.deepEqual(
		ENV_VARS.every((v) => v.startsWith("NTFY_")),
		true,
	);
});
