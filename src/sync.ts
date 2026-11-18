/**
 * Sending a message from a place that cannot await one.
 *
 * ## Why this shells out to `curl`
 *
 * `fetch` cannot be awaited from the paths that need it most. A process that ends by a
 * *synchronous* `process.exit()` — a refusal, a signal handler's shutdown deadline, an
 * `exit` listener — runs its exit handlers and nothing asynchronous; an uncaught exception
 * gets no further turn of the event loop, let alone a network round trip. A subprocess under
 * `spawnSync()` blocks until the POST is done, from inside any of them.
 *
 * The price is a dependency on `curl` (and, on Deno, the `--allow-run` permission), which is
 * why {@link haveCurl} exists: a program configured to notify should refuse to start without
 * it. Being told at 4am that no message is coming beats inferring it from silence at 8.
 *
 * Needs `node:child_process`, so it is kept out of the browser-safe core (`mod.ts`): import it
 * from `@marianmeres/ntfy/sync`. The JSR `.` entry re-exports it as well.
 *
 * @module
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createClog } from "@marianmeres/clog";
import { buildNtfyRequest } from "./request.ts";
import {
	DEFAULT_TIMEOUT,
	NtfyConfigError,
	NtfyError,
	type NtfyLogger,
	type NtfyOptions,
	type NtfyRequest,
	type NtfyResult,
} from "./types.ts";

const clog = createClog("ntfy");

const defaultLogger: NtfyLogger = { warn: clog.warn, error: clog.error };

/** Is `curl` there at all? Ask once, up front, so "no message is coming" is said in advance. */
export function haveCurl(): boolean {
	try {
		const result = spawnSync("curl", ["--version"], { stdio: "ignore" });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/**
 * {@link ntfySend}, blocking, via `curl`. Reports the same {@link NtfyResult}.
 *
 * "Blocking" is literal: the event loop does not turn while curl runs, which is exactly what
 * makes this usable from an exit handler.
 *
 * `--retry` because the interesting case is a laptop whose network is asleep at 4am, and a
 * program that ran for four hours can afford a few seconds to say how it went.
 * `--fail-with-body` because ntfy answers a bad topic or a bad token with a 4xx and a JSON
 * explanation, and curl would otherwise call that a success.
 *
 * Uploading a file is not supported here — an exit handler is no place for it; use
 * {@link ntfySend}.
 *
 * ## The token is visible in the process table
 *
 * curl's arguments are, for the life of the request, and this sender passes the
 * `Authorization` header as one. An ntfy token is normally publish-only to one topic; if yours
 * is worth more than that, put it in the URL's `?auth=` query parameter instead — which is no
 * better, so really: give the sender a token that can only publish.
 */
export function ntfySendSync(options: NtfyOptions | string): NtfyResult {
	const o: NtfyOptions = typeof options === "string" ? { message: options } : options;
	const log = o.logger === false ? null : (o.logger ?? defaultLogger);

	let request: NtfyRequest;
	try {
		if (o.attachment) {
			throw new NtfyConfigError(
				"ntfySync cannot upload a file — use ntfySend (async) for attachments",
			);
		}
		request = buildNtfyRequest(o);
	} catch (e) {
		const error = e instanceof NtfyConfigError ? e.message : String(e);
		if (o.throwOnError) throw e;
		log?.error(`refusing to send — ${error}`);
		return { ok: false, status: 0, error };
	}

	if (o.dryRun) return { ok: true, status: 0, request, dryRun: true };

	const timeoutSec = Math.max(1, Math.round((o.timeout ?? DEFAULT_TIMEOUT) / 1000));
	const args = [
		"-sS",
		"--fail-with-body",
		"-m",
		String(timeoutSec),
		"--retry",
		"2",
		"--retry-delay",
		"1",
		"--retry-connrefused",
		"-X",
		request.method,
	];
	for (const [name, value] of Object.entries(request.headers)) {
		args.push("-H", `${name}: ${value}`);
	}
	if (typeof request.body === "string" && request.body !== "") {
		args.push("--data-raw", request.body);
	}
	args.push(request.url);

	let output: SpawnSyncReturns<string>;
	try {
		output = spawnSync("curl", args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		});
		// A missing binary (ENOENT) is reported here, not thrown.
		if (output.error) throw output.error;
	} catch (e) {
		const error = `could not run curl: ${e instanceof Error ? e.message : String(e)}`;
		if (o.throwOnError) throw new NtfyError(error, { url: request.url, cause: e });
		log?.warn(error);
		return { ok: false, status: 0, request, error };
	}

	if (output.status === 0) {
		return { ok: true, status: 200, request };
	}

	const said = [output.stderr, output.stdout]
		.map((s) => (s ?? "").trim().split("\n")[0])
		.filter(Boolean)
		.join(" · ");
	// A curl killed by a signal has no exit status.
	const code = output.status ?? output.signal;
	const error = `curl exit ${code}${said ? ` — ${said}` : ""}`;
	if (o.throwOnError) throw new NtfyError(error, { url: request.url });
	log?.warn(`could not send to ${request.url} — ${error}`);
	return { ok: false, status: 0, request, error };
}

/**
 * Send one message, blocking until it is delivered or has failed. `true` if curl was happy.
 *
 * ```ts
 * process.on("exit", () => {
 *     ntfySync({ topic: "alerts", message: "process exited", priority: 4 });
 * });
 * ```
 */
export function ntfySync(options: NtfyOptions | string): boolean {
	return ntfySendSync(options).ok;
}
