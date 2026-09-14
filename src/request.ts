/**
 * Options in, one unsent HTTP request out. Pure: no network, no clock, no environment.
 *
 * Everything that can be wrong with a message is decided here and nowhere else, before a single
 * byte is spent — a bad topic, a fourth action button, a title over ntfy's 1 KB limit. That
 * makes `dryRun` a genuine pre-flight check rather than a partial one, and it makes the whole
 * validation surface testable without a server.
 *
 * @module
 */

import { jsonUrl, type NtfyTarget, resolveTarget, topicUrl } from "./target.ts";
import {
	MAX_ACTIONS,
	MESSAGE_SIZE_LIMIT,
	type NtfyAction,
	NtfyConfigError,
	type NtfyOptions,
	type NtfyPriority,
	type NtfyRequest,
	type NtfyTransport,
	TAGS_SIZE_LIMIT,
	TITLE_SIZE_LIMIT,
} from "./types.ts";

/** ntfy's named priorities, in its own order. `urgent` is an alias of `max`. */
const PRIORITY_BY_NAME: Record<string, number> = {
	min: 1,
	low: 2,
	default: 3,
	high: 4,
	max: 5,
	urgent: 5,
};

/** A `Date` far enough in the future to be a millisecond timestamp someone forgot to divide. */
const MILLISECOND_TIMESTAMP_FLOOR = 1e11;

const encoder = new TextEncoder();

/** UTF-8 length, which is what every one of ntfy's byte limits is measured in. */
function byteLength(s: string): number {
	return encoder.encode(s).length;
}

/**
 * HTTP headers are ASCII by convention and by many libraries' implementation. ntfy decodes
 * RFC 2047 encoded-words, which is how a title carrying a non-ASCII character arrives as
 * itself rather than as mojibake.
 */
export function encodeHeaderValue(value: string): string {
	const oneLine = value.replace(/[\r\n]+/g, " ").trim();
	if (/^[\x20-\x7e]*$/.test(oneLine)) return oneLine;
	let binary = "";
	for (const byte of encoder.encode(oneLine)) binary += String.fromCharCode(byte);
	return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** base64 of `user:pass`, UTF-8 safe — `btoa` alone throws on anything above U+00FF. */
function basicAuth(username: string, password: string): string {
	let binary = "";
	for (const byte of encoder.encode(`${username}:${password}`)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** 1–5, from a number or one of ntfy's names. Accepts unvalidated input (env vars, CLI flags). */
export function normalizePriority(
	priority: NtfyPriority | number | string,
): 1 | 2 | 3 | 4 | 5 {
	// "5" arrives from a CLI flag and an env var alike; both mean the number.
	if (typeof priority === "string" && /^\s*\d+\s*$/.test(priority)) {
		priority = Number(priority);
	}
	if (typeof priority === "number") {
		if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
			throw new NtfyConfigError(
				`priority must be 1–5 or a name (min, low, default, high, max, urgent), got ${priority}`,
			);
		}
		return priority as 1 | 2 | 3 | 4 | 5;
	}
	const value = PRIORITY_BY_NAME[String(priority).trim().toLowerCase()];
	if (value === undefined) {
		throw new NtfyConfigError(
			`unknown priority: ${JSON.stringify(priority)} ` +
				`(1–5, min, low, default, high, max, urgent)`,
		);
	}
	return value as 1 | 2 | 3 | 4 | 5;
}

/** A clean tag list from either an array or a comma-separated string. */
export function normalizeTags(tags: string[] | string): string[] {
	const list = (Array.isArray(tags) ? tags : tags.split(","))
		.map((t) => String(t).trim())
		.filter(Boolean);
	const size = list.reduce((sum, t) => sum + byteLength(t), 0);
	if (size > TAGS_SIZE_LIMIT) {
		throw new NtfyConfigError(
			`tags are ${size} bytes, over ntfy's ${TAGS_SIZE_LIMIT} byte limit`,
		);
	}
	return list;
}

/**
 * ntfy's delay parameter, as a string.
 *
 * A `Date` becomes a Unix timestamp in seconds. A bare number is *seconds* too — so a
 * `Date.now()` that slipped through is refused rather than scheduled for the year 5138.
 */
export function normalizeDelay(delay: string | number | Date): string {
	if (delay instanceof Date) {
		if (Number.isNaN(delay.getTime())) {
			throw new NtfyConfigError("delay is an invalid Date");
		}
		return String(Math.floor(delay.getTime() / 1000));
	}
	if (typeof delay === "number") {
		if (!Number.isFinite(delay)) {
			throw new NtfyConfigError(`delay is not a finite number: ${delay}`);
		}
		if (delay >= MILLISECOND_TIMESTAMP_FLOOR) {
			throw new NtfyConfigError(
				`delay ${delay} looks like milliseconds — a numeric delay is a Unix timestamp in ` +
					`seconds; pass a Date for an absolute time`,
			);
		}
		return String(Math.floor(delay));
	}
	const value = delay.trim();
	if (!value) throw new NtfyConfigError("delay is empty");
	return value;
}

/** Reject an action ntfy would reject, with a message that says which one and why. */
function validateActions(actions: NtfyAction[]): NtfyAction[] {
	if (actions.length > MAX_ACTIONS) {
		throw new NtfyConfigError(
			`${actions.length} actions, but ntfy shows at most ${MAX_ACTIONS}`,
		);
	}
	actions.forEach((action, i) => {
		const at = `action[${i}]`;
		if (!action || typeof action !== "object") {
			throw new NtfyConfigError(`${at} is not an action object`);
		}
		if (!action.label?.trim()) throw new NtfyConfigError(`${at} has no label`);
		switch (action.action) {
			case "view":
			case "http":
				if (!action.url?.trim()) {
					throw new NtfyConfigError(`${at} (${action.action}) has no url`);
				}
				break;
			case "copy":
				if (typeof action.value !== "string" || !action.value) {
					throw new NtfyConfigError(`${at} (copy) has no value`);
				}
				break;
			case "broadcast":
				break;
			default:
				throw new NtfyConfigError(
					`${at} has unknown type ${
						JSON.stringify((action as NtfyAction).action)
					} ` +
						`(view, http, broadcast, copy)`,
				);
		}
	});
	return actions;
}

/** http(s) only — what ntfy validates `icon` and `attach` against. */
function validateHttpUrl(value: string, what: string): string {
	if (!/^https?:\/\/\S+$/i.test(value.trim())) {
		throw new NtfyConfigError(
			`${what} must be an http(s) URL, got ${JSON.stringify(value)}`,
		);
	}
	return value.trim();
}

/** Bytes of an attachment, for the transport decision. `Blob` reports its own size. */
function attachmentSize(data: Uint8Array | ArrayBuffer | Blob): number {
	if (data instanceof Uint8Array) return data.byteLength;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return data.size;
}

/** Everything normalized, before it is shaped into JSON or headers. */
interface Normalized {
	target: NtfyTarget;
	message: string;
	title?: string;
	priority?: number;
	tags?: string[];
	click?: string;
	markdown?: boolean;
	icon?: string;
	attach?: string;
	filename?: string;
	actions?: NtfyAction[];
	actionsRaw?: string;
	delay?: string;
	email?: string;
	call?: string;
	cache?: boolean;
	firebase?: boolean;
	sequenceId?: string;
}

/** Validate and normalize, once, for both transports. */
function normalize(o: NtfyOptions): Normalized {
	const n: Normalized = {
		target: resolveTarget(o),
		message: o.message ?? "",
	};

	if (o.title !== undefined && o.title !== "") {
		const size = byteLength(o.title);
		if (size > TITLE_SIZE_LIMIT) {
			throw new NtfyConfigError(
				`title is ${size} bytes, over ntfy's ${TITLE_SIZE_LIMIT} byte limit`,
			);
		}
		n.title = o.title;
	}
	if (o.priority !== undefined) n.priority = normalizePriority(o.priority);
	if (o.tags !== undefined) {
		const tags = normalizeTags(o.tags);
		if (tags.length) n.tags = tags;
	}
	if (o.click) n.click = o.click.trim();
	if (o.markdown) n.markdown = true;
	if (o.icon) n.icon = validateHttpUrl(o.icon, "icon");
	if (o.attach) n.attach = validateHttpUrl(o.attach, "attach");
	if (o.filename) n.filename = o.filename.trim();
	if (o.actions !== undefined) {
		if (typeof o.actions === "string") {
			const raw = o.actions.trim();
			if (raw) n.actionsRaw = raw;
		} else if (o.actions.length) {
			n.actions = validateActions(o.actions);
		}
	}
	if (o.delay !== undefined) n.delay = normalizeDelay(o.delay);
	if (o.email) n.email = o.email.trim();
	if (o.call) n.call = String(o.call).trim();
	if (o.cache === false) n.cache = false;
	if (o.firebase === false) n.firebase = false;
	if (o.sequenceId) n.sequenceId = o.sequenceId.trim();

	// ntfy refuses these combinations itself; saying so here costs nothing and saves a round trip.
	if (n.delay && n.cache === false) {
		throw new NtfyConfigError("a delayed message cannot also disable the cache");
	}
	if (n.delay && n.email) {
		throw new NtfyConfigError("ntfy cannot delay an e-mail notification");
	}
	if (n.delay && n.call) {
		throw new NtfyConfigError("ntfy cannot delay a phone call");
	}
	if (o.token && (o.username || o.password)) {
		throw new NtfyConfigError(
			"pass either `token` or `username`/`password`, not both",
		);
	}
	if ((o.username && !o.password) || (!o.username && o.password)) {
		throw new NtfyConfigError("basic auth needs both `username` and `password`");
	}
	return n;
}

/** Which wire format this message needs, once `auto` is resolved. */
export function resolveTransport(o: NtfyOptions): Exclude<NtfyTransport, "auto"> {
	const wanted: NtfyTransport = o.transport ?? "auto";
	const needsBody = !!o.attachment ||
		typeof o.actions === "string" ||
		byteLength(o.message ?? "") > MESSAGE_SIZE_LIMIT;

	if (wanted === "json") {
		if (o.attachment) {
			throw new NtfyConfigError(
				"an uploaded attachment needs the body transport (the JSON body is the file)",
			);
		}
		if (typeof o.actions === "string") {
			throw new NtfyConfigError(
				'short-format actions need the body transport; pass an actions array for transport: "json"',
			);
		}
		if (byteLength(o.message ?? "") > MESSAGE_SIZE_LIMIT) {
			throw new NtfyConfigError(
				`message is over ntfy's ${MESSAGE_SIZE_LIMIT} byte limit; the body transport turns it ` +
					`into an attachment, JSON publishing cannot`,
			);
		}
		return "json";
	}
	if (wanted === "body") return "body";
	return needsBody ? "body" : "json";
}

/** Auth + caller-supplied headers, applied to both transports identically. */
function commonHeaders(o: NtfyOptions, headers: Record<string, string>): void {
	if (o.token) headers["Authorization"] = `Bearer ${o.token}`;
	else if (o.username && o.password) {
		headers["Authorization"] = `Basic ${basicAuth(o.username, o.password)}`;
	}
	for (const [key, value] of Object.entries(o.headers ?? {})) {
		if (value !== undefined && value !== null) headers[key] = String(value);
	}
}

/** One JSON object POSTed to the server root. */
function buildJsonRequest(o: NtfyOptions, n: Normalized): NtfyRequest {
	const payload: Record<string, unknown> = { topic: n.target.topic };
	if (n.message) payload.message = n.message;
	if (n.title) payload.title = n.title;
	if (n.priority) payload.priority = n.priority;
	if (n.tags) payload.tags = n.tags;
	if (n.click) payload.click = n.click;
	if (n.markdown) payload.markdown = true;
	if (n.icon) payload.icon = n.icon;
	if (n.attach) payload.attach = n.attach;
	if (n.filename) payload.filename = n.filename;
	if (n.actions) payload.actions = n.actions;
	if (n.delay) payload.delay = n.delay;
	if (n.email) payload.email = n.email;
	if (n.call) payload.call = n.call;
	// Undocumented in ntfy's JSON field table, but read by its transformBodyJSON handler.
	if (n.cache === false) payload.cache = "no";
	if (n.firebase === false) payload.firebase = "no";
	if (n.sequenceId) payload.sequence_id = n.sequenceId;

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	commonHeaders(o, headers);

	return {
		method: "POST",
		url: jsonUrl(n.target),
		headers,
		body: JSON.stringify(payload),
		transport: "json",
	};
}

/**
 * The message (or a file) as the request body, everything else as `X-*` headers.
 *
 * A header cannot hold a newline, so a multi-line message travelling in `X-Message` is folded
 * to the literal `\n` that ntfy expands again on arrival. The round trip is lossy in exactly one
 * case — a message that already contained the two characters `\` `n` comes out as a newline —
 * which is ntfy's behaviour, not this library's, and only applies when a file is attached.
 */
function buildBodyRequest(o: NtfyOptions, n: Normalized): NtfyRequest {
	const headers: Record<string, string> = {};
	const set = (name: string, value: string | undefined) => {
		if (value !== undefined && value !== "") headers[name] = encodeHeaderValue(value);
	};

	const hasFile = !!o.attachment;
	if (hasFile && n.message) set("X-Message", n.message.replace(/\r?\n/g, "\\n"));
	set("X-Title", n.title);
	if (n.priority) headers["X-Priority"] = String(n.priority);
	if (n.tags) set("X-Tags", n.tags.join(","));
	set("X-Click", n.click);
	if (n.markdown) headers["X-Markdown"] = "yes";
	set("X-Icon", n.icon);
	set("X-Attach", n.attach);
	set("X-Filename", n.filename);
	if (n.actionsRaw) set("X-Actions", n.actionsRaw);
	else if (n.actions) set("X-Actions", JSON.stringify(n.actions));
	set("X-Delay", n.delay);
	set("X-Email", n.email);
	set("X-Call", n.call);
	if (n.cache === false) headers["X-Cache"] = "no";
	if (n.firebase === false) headers["X-Firebase"] = "no";
	set("X-Sequence-ID", n.sequenceId);

	let body: NtfyRequest["body"];
	if (hasFile) {
		body = o.attachment;
		if (!headers["Content-Type"] && !(o.attachment instanceof Blob)) {
			headers["Content-Type"] = "application/octet-stream";
		}
	} else {
		body = n.message;
		if (n.message) headers["Content-Type"] = "text/plain; charset=utf-8";
	}
	commonHeaders(o, headers);

	return {
		method: hasFile ? "PUT" : "POST",
		url: topicUrl(n.target),
		headers,
		body,
		transport: "body",
	};
}

/**
 * Build the HTTP request one set of options describes, validating everything on the way.
 *
 * Exported because a request you can inspect is a request you can test, log and rehearse —
 * `dryRun` is this function and nothing else.
 *
 * @throws {NtfyConfigError} for anything that could never be sent as written.
 */
export function buildNtfyRequest(options: NtfyOptions | string): NtfyRequest {
	const o: NtfyOptions = typeof options === "string" ? { message: options } : options;
	const transport = resolveTransport(o);
	const n = normalize(o);

	// A small, valid-UTF-8 body with no filename is taken by ntfy as the *message text*, not as
	// an attachment — which is not what `attachment:` asked for. A name forces the attachment
	// reading. Above the text limit ntfy always treats the body as an attachment and names it
	// from the detected content type, which is better than anything invented here, so leave it.
	const size = o.attachment ? attachmentSize(o.attachment) : 0;
	if (o.attachment && !n.filename && size > 0 && size <= MESSAGE_SIZE_LIMIT) {
		n.filename = "attachment";
	}
	return transport === "json" ? buildJsonRequest(o, n) : buildBodyRequest(o, n);
}
