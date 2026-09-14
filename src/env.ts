/**
 * `NTFY_*` environment variables, turned into {@link NtfyOptions}.
 *
 * Pure: the environment arrives as an injected getter, never as `Deno.env` or `process.env`
 * read from under the caller. The library itself never calls this — the CLI does, and so can
 * you, explicitly:
 *
 * ```ts
 * const notify = createNtfy(optionsFromEnv(Deno.env.get));
 * ```
 *
 * That keeps the ambient environment a decision rather than a surprise: two libraries that both
 * read `NTFY_TOPIC` on their own are two libraries that cannot be told apart when the wrong
 * phone buzzes.
 *
 * @module
 */

import { normalizePriority } from "./request.ts";
import { NtfyConfigError, type NtfyOptions } from "./types.ts";

/** How an environment is read. `Deno.env.get` and `(k) => process.env[k]` both satisfy it. */
export type EnvGetter = (key: string) => string | undefined;

/** Every variable {@link optionsFromEnv} looks at, in the order it reports them. */
export const ENV_VARS: readonly string[] = [
	"NTFY_TOPIC",
	"NTFY_SERVER",
	"NTFY_TOKEN",
	"NTFY_USERNAME",
	"NTFY_PASSWORD",
	"NTFY_PRIORITY",
	"NTFY_TAGS",
	"NTFY_TITLE",
	"NTFY_ICON",
	"NTFY_CLICK",
	"NTFY_TIMEOUT",
];

function read(env: EnvGetter, key: string): string | undefined {
	const value = env(key);
	if (value === undefined || value === null) return undefined;
	const trimmed = String(value).trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Read `NTFY_TOPIC`, `NTFY_SERVER`, `NTFY_TOKEN`, `NTFY_USERNAME`, `NTFY_PASSWORD`,
 * `NTFY_PRIORITY`, `NTFY_TAGS`, `NTFY_TITLE`, `NTFY_ICON`, `NTFY_CLICK` and `NTFY_TIMEOUT`.
 *
 * Unset and empty are the same thing — an exported-but-empty variable is a mistake, not an
 * instruction. Only fields that were actually set appear in the result, so it can be spread
 * over defaults without blanking them.
 *
 * @throws {NtfyConfigError} when a variable is set to something unusable (a priority of `loud`,
 * a timeout of `soon`). A typo in a notification's configuration should be found at startup,
 * not at 4am when the message does not arrive.
 */
export function optionsFromEnv(env: EnvGetter): NtfyOptions {
	const o: NtfyOptions = {};

	const topic = read(env, "NTFY_TOPIC");
	if (topic) o.topic = topic;

	const server = read(env, "NTFY_SERVER");
	if (server) o.server = server;

	const token = read(env, "NTFY_TOKEN");
	if (token) o.token = token;

	const username = read(env, "NTFY_USERNAME");
	if (username) o.username = username;

	const password = read(env, "NTFY_PASSWORD");
	if (password) o.password = password;

	const priority = read(env, "NTFY_PRIORITY");
	if (priority) {
		try {
			o.priority = normalizePriority(priority);
		} catch (e) {
			throw new NtfyConfigError(
				`NTFY_PRIORITY: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	const tags = read(env, "NTFY_TAGS");
	if (tags) o.tags = tags;

	const title = read(env, "NTFY_TITLE");
	if (title) o.title = title;

	const icon = read(env, "NTFY_ICON");
	if (icon) o.icon = icon;

	const click = read(env, "NTFY_CLICK");
	if (click) o.click = click;

	const timeout = read(env, "NTFY_TIMEOUT");
	if (timeout) {
		const ms = Number(timeout);
		if (!Number.isFinite(ms) || ms < 0) {
			throw new NtfyConfigError(
				`NTFY_TIMEOUT must be a number of milliseconds, got ${
					JSON.stringify(timeout)
				}`,
			);
		}
		o.timeout = ms;
	}

	return o;
}
