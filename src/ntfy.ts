/**
 * Sending. Everything that touches the network lives here; everything it sends was decided in
 * {@link buildNtfyRequest}.
 *
 * ## Why failure is loud by default
 *
 * The moment a program notifies, *no* message starts to mean "nothing happened". A send that
 * fails quietly turns that inference into a lie, which is why a swallowed failure is still
 * written to a log — `logger: false` is available, and is a deliberate choice to be lied to.
 *
 * @module
 */

import { createClog } from "@marianmeres/clog";
import { buildNtfyRequest } from "./request.ts";
import {
	DEFAULT_TIMEOUT,
	NtfyConfigError,
	NtfyError,
	type NtfyLogger,
	type NtfyMessage,
	type NtfyOptions,
	type NtfyRequest,
	type NtfyResult,
} from "./types.ts";

const clog = createClog("ntfy");

/** The default sink for swallowed failures. */
const defaultLogger: NtfyLogger = { warn: clog.warn, error: clog.error };

function loggerOf(o: NtfyOptions): NtfyLogger | null {
	if (o.logger === false) return null;
	return o.logger ?? defaultLogger;
}

/** An `AbortSignal` that fires on the caller's signal or on the timeout, whichever comes first. */
function abortController(o: NtfyOptions): {
	signal: AbortSignal;
	timedOut: () => boolean;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timeout = o.timeout ?? DEFAULT_TIMEOUT;
	let timedOut = false;

	const timer = timeout > 0
		? setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeout)
		: undefined;

	const onAbort = () => controller.abort();
	if (o.signal) {
		if (o.signal.aborted) controller.abort();
		else o.signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** ntfy answers a refusal with `{"code":…,"http":…,"error":…,"link":…}`. */
function describeFailure(status: number, statusText: string, body: string): {
	error: string;
	errorCode?: number;
} {
	let detail = statusText || "";
	let errorCode: number | undefined;
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			if (typeof parsed.error === "string") detail = parsed.error;
			if (typeof parsed.code === "number") errorCode = parsed.code;
		}
	} catch {
		const firstLine = body.trim().split("\n")[0];
		if (firstLine) detail = firstLine;
	}
	const suffix = errorCode ? ` (code ${errorCode})` : "";
	return { error: `HTTP ${status}${detail ? ` — ${detail}` : ""}${suffix}`, errorCode };
}

/**
 * Send one message and report everything that happened.
 *
 * Never throws unless {@link NtfyOptions.throwOnError} says to: a notification is a side
 * channel, and an unreachable phone must not be able to change what the program it is watching
 * decides to do.
 */
export async function ntfySend(options: NtfyOptions | string): Promise<NtfyResult> {
	const o: NtfyOptions = typeof options === "string" ? { message: options } : options;
	const log = loggerOf(o);

	let request: NtfyRequest;
	try {
		request = buildNtfyRequest(o);
	} catch (e) {
		const error = e instanceof NtfyConfigError ? e.message : String(e);
		if (o.throwOnError) throw e;
		log?.error(`refusing to send — ${error}`);
		return { ok: false, status: 0, error };
	}

	if (o.dryRun) return { ok: true, status: 0, request, dryRun: true };

	const doFetch = o.fetch ?? globalThis.fetch;
	const { signal, timedOut, cleanup } = abortController(o);

	try {
		const response = await doFetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body as BodyInit | undefined,
			signal,
		});
		const text = await response.text();

		if (!response.ok) {
			const { error, errorCode } = describeFailure(
				response.status,
				response.statusText,
				text,
			);
			if (o.throwOnError) {
				throw new NtfyError(error, {
					status: response.status,
					code: errorCode,
					url: request.url,
				});
			}
			log?.warn(`could not send to ${request.url} — ${error}`);
			return { ok: false, status: response.status, request, error, errorCode };
		}

		let message: NtfyMessage | undefined;
		try {
			message = JSON.parse(text) as NtfyMessage;
		} catch {
			// A proxy that rewrites the body does not make a delivered message undelivered.
		}
		return { ok: true, status: response.status, request, message };
	} catch (e) {
		if (e instanceof NtfyError) throw e;
		const reason = timedOut()
			? `timed out after ${o.timeout ?? DEFAULT_TIMEOUT}ms`
			: e instanceof Error
			? e.message
			: String(e);
		const error = `could not reach ${request.url} — ${reason}`;
		if (o.throwOnError) {
			throw new NtfyError(error, { url: request.url, cause: e });
		}
		log?.warn(error);
		return { ok: false, status: 0, request, error };
	} finally {
		cleanup();
	}
}

/**
 * Send one message. `true` if ntfy took it.
 *
 * The one-liner this package exists for:
 *
 * ```ts
 * await ntfy({ topic: "alerts", message: "backup finished" });
 * ```
 */
export async function ntfy(options: NtfyOptions | string): Promise<boolean> {
	return (await ntfySend(options)).ok;
}

/**
 * Bind defaults once, then send with a string.
 *
 * This is how a program gets `notify("done")` without the library reading your environment
 * behind your back — you decide where the topic and token come from, including
 * `optionsFromEnv` if that is what you want.
 *
 * ```ts
 * const notify = createNtfy({ topic: "alerts", token: myToken, tags: ["robot"] });
 * await notify("backup finished");
 * await notify({ message: "backup failed", priority: 5, tags: ["rotating_light"] });
 * ```
 */
export function createNtfy(
	defaults: NtfyOptions,
): (options: NtfyOptions | string) => Promise<boolean> {
	return (options) => ntfy(mergeOptions(defaults, options));
}

/** {@link createNtfy}, reporting the full {@link NtfyResult}. */
export function createNtfySend(
	defaults: NtfyOptions,
): (options: NtfyOptions | string) => Promise<NtfyResult> {
	return (options) => ntfySend(mergeOptions(defaults, options));
}

/** Per-call options win, field by field. */
export function mergeOptions(
	defaults: NtfyOptions,
	options: NtfyOptions | string,
): NtfyOptions {
	const o: NtfyOptions = typeof options === "string" ? { message: options } : options;
	return {
		...defaults,
		...o,
		headers: { ...defaults.headers, ...o.headers },
	};
}
