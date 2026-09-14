/**
 * Turning "where do I send this" into a URL.
 *
 * Four spellings mean the same thing to a person — a bare topic, `host/topic`, a full URL, or a
 * server and a topic given separately — and all four have to land on the same two endpoints:
 * the server root (JSON publishing) and the topic URL (body publishing). Anything that does not
 * resolve unambiguously is refused rather than guessed at: a message that silently goes
 * somewhere unexpected is worse than one that visibly goes nowhere.
 *
 * @module
 */

import { DEFAULT_SERVER, NtfyConfigError, TOPIC_REGEX } from "./types.ts";

/** A resolved target, split into the two URLs the transports need. */
export interface NtfyTarget {
	/** Server root, with any sub-path, without a trailing slash. `https://ntfy.sh` */
	base: string;
	/** Bare topic name. `alerts` */
	topic: string;
	/** Query string carried over from the input, including the leading `?`. Usually `?auth=…`. */
	search: string;
}

/** Where JSON publishing posts: the server root, never the topic URL. */
export function jsonUrl(t: NtfyTarget): string {
	return `${t.base}/${t.search}`;
}

/** Where body publishing posts: the topic URL. */
export function topicUrl(t: NtfyTarget): string {
	return `${t.base}/${t.topic}${t.search}`;
}

/** Strip trailing slashes without eating the whole string. */
function trimSlashes(s: string): string {
	return s.replace(/\/+$/, "");
}

/**
 * Resolve `server` + `topic` into a {@link NtfyTarget}.
 *
 * `topic` wins when it carries a host of its own, so a single string is always enough:
 * `resolveTarget({ topic: "https://ntfy.example.com/alerts" })`. When `topic` is missing, a
 * `server` that ends in a topic supplies it — which is what makes one `NTFY_TOPIC` or one
 * `--topic` flag sufficient in every spelling a person is likely to type.
 *
 * @throws {NtfyConfigError} when no topic can be determined, or one is not a valid ntfy topic.
 */
export function resolveTarget(
	options: { server?: string; topic?: string } = {},
): NtfyTarget {
	const rawTopic = (options.topic ?? "").trim();
	const rawServer = (options.server ?? "").trim();

	// A bare word is a topic on whichever server we were given (ntfy.sh by default). This is
	// checked before URL parsing because `new URL("https://alerts")` succeeds — a bare word
	// parses as a *host*, which would silently send to a server that does not exist.
	if (rawTopic && !/[/.:]/.test(rawTopic)) {
		if (!TOPIC_REGEX.test(rawTopic)) {
			throw new NtfyConfigError(
				`not a valid ntfy topic: ${JSON.stringify(rawTopic)} ` +
					`(letters, digits, - and _, up to 64 characters)`,
			);
		}
		return { ...splitServer(rawServer || DEFAULT_SERVER, rawTopic), topic: rawTopic };
	}

	// Otherwise the topic itself is a target and replaces the server entirely.
	if (rawTopic) return parseTarget(rawTopic);

	// No topic at all: the server may still end in one.
	if (rawServer) return parseTarget(rawServer);

	throw new NtfyConfigError(
		'no topic: pass `topic` (or NTFY_TOPIC / --topic) — e.g. "alerts" or ' +
			'"https://ntfy.example.com/alerts"',
	);
}

/** Split a bare server URL into base + search, keeping any sub-path. */
function splitServer(server: string, forTopic: string): NtfyTarget {
	const u = toURL(server, `server`);
	const path = trimSlashes(u.pathname);
	return {
		base: trimSlashes(u.origin + path),
		topic: forTopic,
		search: u.search,
	};
}

/** Parse `host/topic`, `https://host/path/topic` or `https://host/topic?auth=…`. */
function parseTarget(raw: string): NtfyTarget {
	const u = toURL(raw, "topic");
	const segments = trimSlashes(u.pathname).split("/").filter(Boolean);
	const topic = segments.pop() ?? "";
	if (!topic) {
		throw new NtfyConfigError(
			`names a server but no topic: ${JSON.stringify(raw)}`,
		);
	}
	if (!TOPIC_REGEX.test(topic)) {
		throw new NtfyConfigError(
			`does not end in a single ntfy topic: ${JSON.stringify(raw)} ` +
				`(letters, digits, - and _, up to 64 characters)`,
		);
	}
	const prefix = segments.length ? `/${segments.join("/")}` : "";
	return { base: `${u.origin}${prefix}`, topic, search: u.search };
}

/** `https://` is assumed, because nobody types a scheme into a `--topic` flag. */
function toURL(raw: string, what: string): URL {
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
	try {
		return new URL(withScheme);
	} catch {
		throw new NtfyConfigError(`not a valid ${what} URL: ${JSON.stringify(raw)}`);
	}
}
