/**
 * Public types, constants and errors for `@marianmeres/ntfy`.
 *
 * Everything here is pure data — no I/O, no runtime globals — so it compiles for npm as
 * happily as it runs on Deno.
 *
 * @module
 */

/**
 * ntfy's own rule for what a topic may be made of. A slash in one is a mistyped URL, not a
 * topic, which is why {@link resolveTarget} treats the two spellings differently.
 */
export const TOPIC_REGEX: RegExp = /^[A-Za-z0-9_-]{1,64}$/;

/** Where a message goes when nothing says otherwise. */
export const DEFAULT_SERVER = "https://ntfy.sh";

/** How long a request may take before it is abandoned, in milliseconds. */
export const DEFAULT_TIMEOUT = 10_000;

/**
 * Bytes of `message` ntfy still treats as text. Above this the server turns the message into
 * an attachment instead — but only on the body transport, so {@link buildNtfyRequest} switches
 * to it rather than letting a long message become an HTTP 413.
 */
export const MESSAGE_SIZE_LIMIT = 4096;

/** ntfy rejects a title over 1 KB with HTTP 400. */
export const TITLE_SIZE_LIMIT = 1024;

/** ntfy rejects tags totalling over 512 bytes with HTTP 400. */
export const TAGS_SIZE_LIMIT = 512;

/** ntfy shows at most three action buttons. */
export const MAX_ACTIONS = 3;

/** The named priorities ntfy understands, as an alternative to 1–5. */
export type NtfyPriorityName = "min" | "low" | "default" | "high" | "max" | "urgent";

/** `1` (min) … `5` (max), or the equivalent name. `4` is the level that gets through a phone's default rules. */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5 | NtfyPriorityName;

/** Fields every action button shares. */
export interface NtfyActionBase {
	/** Button text. */
	label: string;
	/** Dismiss the notification after the button is tapped. Default `false`. */
	clear?: boolean;
}

/** Open a website or app. */
export interface NtfyViewAction extends NtfyActionBase {
	action: "view";
	url: string;
}

/** Send an HTTP request from the phone. */
export interface NtfyHttpAction extends NtfyActionBase {
	action: "http";
	url: string;
	/** Default `POST` (ntfy's default, not this library's). */
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	headers?: Record<string, string>;
	body?: string;
}

/** Send an Android broadcast intent. */
export interface NtfyBroadcastAction extends NtfyActionBase {
	action: "broadcast";
	/** Default `io.heckel.ntfy.USER_ACTION`. */
	intent?: string;
	extras?: Record<string, string>;
}

/** Copy a value to the clipboard. */
export interface NtfyCopyAction extends NtfyActionBase {
	action: "copy";
	value: string;
}

/** One of ntfy's four action button types. */
export type NtfyAction =
	| NtfyViewAction
	| NtfyHttpAction
	| NtfyBroadcastAction
	| NtfyCopyAction;

/**
 * Action buttons, either structured or in ntfy's own short format
 * (`"view, Open, https://example.com; http, Approve, https://api.example.com, method=PUT"`).
 *
 * A short-format string is passed to the server verbatim and parsed there, which is why it
 * forces the body transport — JSON publishing only accepts the structured array.
 */
export type NtfyActions = NtfyAction[] | string;

/** Attachment bytes. A path is not accepted here: reading it is I/O, and the core does none. */
export type NtfyAttachmentData = Uint8Array | ArrayBuffer | Blob;

/**
 * How the message is put on the wire.
 *
 * - `json` — one JSON object POSTed to the server root. UTF-8 clean (no header encoding),
 *   structured actions, and the default.
 * - `body` — the message as the request body, everything else as `X-*` headers. The only
 *   transport that can carry an uploaded file, a short-format actions string, or a message
 *   over {@link MESSAGE_SIZE_LIMIT} bytes.
 * - `auto` — `body` when one of those three applies, `json` otherwise. The default.
 */
export type NtfyTransport = "auto" | "json" | "body";

/** Console-compatible sink. `console` itself satisfies it, and so does a `clog` instance. */
export interface NtfyLogger {
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

/**
 * Everything one ntfy message can carry, plus how to reach the server and what to do when it
 * cannot be reached.
 *
 * Nothing here is read from the environment: the library is explicit, and the CLI is the layer
 * that turns `NTFY_*` into these fields (see `optionsFromEnv`).
 */
export interface NtfyOptions {
	/** The notification body. ntfy substitutes `triggered` when it is empty. */
	message?: string;
	/** The notification title. */
	title?: string;
	/**
	 * Target topic. Also accepts a full target — `ntfy.sh/alerts`, `https://ntfy.example.com/alerts`
	 * — in which case it overrides {@link NtfyOptions.server}.
	 */
	topic?: string;
	/** Base URL of the ntfy server. Default {@link DEFAULT_SERVER}. A sub-path is kept. */
	server?: string;
	/** 1–5 or a name. Default is ntfy's own default (3). */
	priority?: NtfyPriority;
	/** Tag names; a known emoji shortcode renders as that emoji. A comma-separated string is split. */
	tags?: string[] | string;
	/** URL opened when the notification is clicked. */
	click?: string;
	/** Render the message as Markdown (supported by the web and iOS clients). */
	markdown?: boolean;
	/** URL of a JPEG/PNG shown as the notification icon. */
	icon?: string;
	/** URL of an external file to attach. For a local file use {@link NtfyOptions.attachment}. */
	attach?: string;
	/** Attachment filename as it appears on the client. Required for text files under 4 KB. */
	filename?: string;
	/** Local file *bytes* to upload as the attachment. Forces the body transport. */
	attachment?: NtfyAttachmentData;
	/** Up to {@link MAX_ACTIONS} action buttons. */
	actions?: NtfyActions;
	/**
	 * Delayed delivery: a duration (`30m`, `2 hours`), a time (`9am`, `tomorrow, 3pm`), a `Date`,
	 * or a Unix timestamp in **seconds**. ntfy allows 10 seconds to 3 days.
	 */
	delay?: string | number | Date;
	/** Forward the notification to this e-mail address, or `yes` for your verified address. */
	email?: string;
	/** Call this phone number and read the message out, or `yes` for your verified number. */
	call?: string;
	/** `false` disables server-side caching of the message. Default `true` (ntfy's default). */
	cache?: boolean;
	/** `false` disables forwarding to Firebase. Default `true` (ntfy's default). */
	firebase?: boolean;
	/** Sequence ID, for later updating or deleting this notification. */
	sequenceId?: string;
	/** Access token, sent as `Authorization: Bearer`. Mutually exclusive with username/password. */
	token?: string;
	/** Basic-auth username. Requires {@link NtfyOptions.password}. */
	username?: string;
	/** Basic-auth password. */
	password?: string;
	/** Extra request headers, merged last — an escape hatch for anything not modelled here. */
	headers?: Record<string, string>;
	/** Wire format. Default `auto`; see {@link NtfyTransport}. */
	transport?: NtfyTransport;
	/** Milliseconds before the request is abandoned. Default {@link DEFAULT_TIMEOUT}. */
	timeout?: number;
	/** Caller's abort signal, honoured alongside the timeout. */
	signal?: AbortSignal;
	/** Throw {@link NtfyError} / {@link NtfyConfigError} instead of returning a failure. Default `false`. */
	throwOnError?: boolean;
	/** Build and validate the request, then return it without sending. */
	dryRun?: boolean;
	/** `fetch` implementation to use. Default the global one. Tests inject theirs here. */
	fetch?: typeof globalThis.fetch;
	/**
	 * Where a swallowed failure is reported. Default: this package's `clog` namespace.
	 * `false` silences it — but then a failed send leaves no trace at all except the return value.
	 */
	logger?: NtfyLogger | false;
}

/** A built, unsent request. The whole of {@link buildNtfyRequest}'s output. */
export interface NtfyRequest {
	method: "POST" | "PUT";
	url: string;
	headers: Record<string, string>;
	/** JSON string, message text, or attachment bytes. `undefined` only for an empty body message. */
	body: string | NtfyAttachmentData | undefined;
	/** Which transport was chosen, after `auto` was resolved. */
	transport: Exclude<NtfyTransport, "auto">;
}

/** The message as the server echoes it back on a successful publish. */
export interface NtfyMessage {
	id: string;
	time: number;
	expires?: number;
	event: string;
	topic: string;
	message?: string;
	title?: string;
	priority?: number;
	tags?: string[];
	click?: string;
	icon?: string;
	actions?: NtfyAction[];
	attachment?: {
		name: string;
		url: string;
		type?: string;
		size?: number;
		expires?: number;
	};
	[key: string]: unknown;
}

/** The full outcome of a send. {@link ntfy} is this, reduced to its `ok`. */
export interface NtfyResult {
	/** Did the server accept the message? A dry run reports `true` without sending. */
	ok: boolean;
	/** HTTP status, or `0` when the request never completed (config error, network, timeout, dry run). */
	status: number;
	/** The request as it was built — the URL actually used, headers, body. */
	request?: NtfyRequest;
	/** The server's echo of the published message. */
	message?: NtfyMessage;
	/** One-line reason for a failure, suitable for logging. */
	error?: string;
	/** ntfy's own numeric error code, when the server sent one. */
	errorCode?: number;
	/** True when nothing was sent because {@link NtfyOptions.dryRun} was set. */
	dryRun?: boolean;
}

/**
 * A message that could never be sent as written: no topic, a bad priority, four action buttons.
 *
 * Deterministic and independent of the network — the same options fail the same way every time,
 * which is what makes a pre-flight check worth running.
 */
export class NtfyConfigError extends Error {
	override readonly name = "NtfyConfigError";
	constructor(message: string) {
		super(message);
	}
}

/** A message the server refused, or that never reached it. Only thrown when `throwOnError` is set. */
export class NtfyError extends Error {
	override readonly name = "NtfyError";
	/** HTTP status, or `0` when the request never completed. */
	readonly status: number;
	/** ntfy's own numeric error code, when the server sent one. */
	readonly code?: number;
	/** The URL that was posted to. */
	readonly url?: string;
	constructor(
		message: string,
		options: { status?: number; code?: number; url?: string; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.status = options.status ?? 0;
		this.code = options.code;
		this.url = options.url;
	}
}
