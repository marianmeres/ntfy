/**
 * First-class CLI for `@marianmeres/ntfy`.
 *
 * ```bash
 * deno run -A jsr:@marianmeres/ntfy "backup finished"
 * mmntfy -t "Deploy" -p 4 --tags rocket "shipped v1.2.3"
 * make build 2>&1 | mmntfy -t "Build log"
 * ```
 *
 * All logic lives in {@link runCli}, which takes an args array and returns an exit code (it
 * never calls `Deno.exit`), so it is testable without spawning a process. Everything external —
 * stdout/stderr, the environment, stdin, the filesystem, `fetch` — is injectable via
 * {@link CliIo}.
 *
 * **This is the only layer that reads the ambient environment.**
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import { loadSync } from "@std/dotenv";
import { basename } from "@std/path";
import denoJson from "../deno.json" with { type: "json" };
import { type EnvGetter, optionsFromEnv } from "./env.ts";
import { ntfySend } from "./ntfy.ts";
import {
	DEFAULT_TIMEOUT,
	NtfyConfigError,
	type NtfyOptions,
	type NtfyRequest,
	type NtfyTransport,
} from "./types.ts";

/** Package version, read from `deno.json` (works when published to JSR). */
const VERSION: string = denoJson.version;

/** The name the binary is usually installed as. */
const BIN = "mmntfy";

/** Injectable collaborators for {@link runCli}. Every field is optional. */
export interface CliIo {
	/** stdout line writer. Default `console.log`. */
	out?: (line: string) => void;
	/** stderr line writer. Default `console.error`. */
	err?: (line: string) => void;
	/** Environment getter. Default `Deno.env.get`. */
	env?: EnvGetter;
	/** Reads all of stdin. Default: drains `Deno.stdin`. */
	readStdin?: () => Promise<string>;
	/** Is stdin a terminal (i.e. nothing is piped in)? Default: probes `Deno.stdin`. */
	isStdinTerminal?: () => boolean;
	/** Reads an attachment. Default `Deno.readFile`. */
	readFile?: (path: string) => Promise<Uint8Array>;
	/** Reads a `.env` file into a record. Default: `@std/dotenv`. */
	readEnvFile?: (path: string) => Record<string, string>;
	/** `fetch` implementation, handed to {@link ntfySend}. Default: the global one. */
	fetch?: typeof globalThis.fetch;
}

interface ResolvedIo {
	out: (line: string) => void;
	err: (line: string) => void;
	env: EnvGetter;
	readStdin: () => Promise<string>;
	isStdinTerminal: () => boolean;
	readFile: (path: string) => Promise<Uint8Array>;
	readEnvFile: (path: string) => Record<string, string>;
	fetch?: typeof globalThis.fetch;
}

/** Signals a usage error → exit code 2. */
class UsageError extends Error {
	override readonly name = "UsageError";
}

const HELP: string = `
${BIN} v${VERSION} — send one ntfy notification.

Usage:
  ${BIN} [options] [message...]
  <command> | ${BIN} [options]

Examples:
  ${BIN} "backup finished"
  ${BIN} -t "Deploy" -p 4 --tags rocket,white_check_mark "shipped v1.2.3"
  make build 2>&1 | ${BIN} -t "Build log" --tags hammer
  ${BIN} -T https://ntfy.example.com/alerts -k tk_AgQd… "to a self-hosted server"
  ${BIN} -f screenshot.png "look at this"
  ${BIN} -n "what would be sent?"

Message:
  Positional arguments, joined with spaces. With none, piped stdin is read
  instead — output over 4 KB is sent as an attachment, which is ntfy's own
  behaviour and what makes piping a long log useful. --stdin forces the read.

Target:
  -T, --topic <topic>       topic, host/topic, or a full URL       [NTFY_TOPIC]
  -s, --server <url>        base URL, default https://ntfy.sh     [NTFY_SERVER]
  -k, --token <tk_...>      access token                           [NTFY_TOKEN]
  -u, --user <user[:pass]>  basic auth                          [NTFY_USERNAME]
      --password <pass>     basic auth password                 [NTFY_PASSWORD]

Message options:
  -t, --title <text>                                              [NTFY_TITLE]
  -p, --priority <1-5|min|low|default|high|max|urgent>         [NTFY_PRIORITY]
      --tags <a,b,c>        emoji shortcodes render as emoji       [NTFY_TAGS]
  -c, --click <url>         opened when the notification is tapped [NTFY_CLICK]
  -m, --markdown            render the message as Markdown
      --icon <url>          notification icon                      [NTFY_ICON]
      --attach <url>        attach a file by URL
  -f, --file <path>         upload a local file as the attachment
      --filename <name>     attachment name shown on the client
  -a, --action <spec>       action button, repeatable (max 3), ntfy short format:
                              "view, Open, https://example.com"
                              "http, Deploy, https://ci/deploy, method=POST"
                              "copy, Copy id, abc123"
  -d, --delay <when>        30m | 9am | "tomorrow, 3pm" | unix seconds
  -e, --email <address>     also forward to e-mail
      --call <number>       also call and read the message out
      --no-cache            do not cache the message server-side
      --no-firebase         do not forward to Firebase
      --sequence-id <id>    id for later updating or deleting this notification
  -H, --header <name: v>    extra request header, repeatable

Behaviour:
      --transport <auto|json|body>   wire format, default auto
      --timeout <ms>        default ${DEFAULT_TIMEOUT}                        [NTFY_TIMEOUT]
      --env-file <path>     load NTFY_* from a .env file first (real env wins)
      --stdin               read the message from stdin even if args are given
  -n, --dry-run             build and validate, print it, send nothing
  -q, --quiet               say nothing on success
  -v, --verbose             print the request and the server's reply
  -h, --help                this
  -V, --version

Exit codes:
  0  sent          1  not sent          2  bad usage or configuration
`.trim();

/** Hide anything that would be regrettable in a terminal scrollback or a CI log. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = /^authorization$/i.test(name)
			? value.replace(
				/\S+$/,
				(secret) =>
					secret.length > 8
						? `${secret.slice(0, 6)}…(redacted)`
						: "…(redacted)",
			)
			: value;
	}
	return out;
}

/** `?auth=` carries credentials too. */
function redactUrl(url: string): string {
	return url.replace(/([?&]auth=)[^&]+/i, "$1…(redacted)");
}

/** What `--dry-run` and `--verbose` print. */
function describeRequest(request: NtfyRequest): string[] {
	const lines = [`${request.method} ${redactUrl(request.url)}  [${request.transport}]`];
	for (const [name, value] of Object.entries(redactHeaders(request.headers))) {
		lines.push(`  ${name}: ${value}`);
	}
	if (typeof request.body === "string") {
		lines.push("", request.body);
	} else if (request.body) {
		const size = request.body instanceof Blob
			? request.body.size
			: (request.body as Uint8Array | ArrayBuffer).byteLength;
		lines.push("", `<${size} bytes of attachment>`);
	}
	return lines;
}

/** `--user alice:secret` and `--user alice --password secret` mean the same thing. */
function splitUser(value: string): { username: string; password?: string } {
	const at = value.indexOf(":");
	if (at < 0) return { username: value };
	return { username: value.slice(0, at), password: value.slice(at + 1) };
}

/** `--header "X-Poll-ID: abc"` */
function parseHeaderFlag(raw: string): [string, string] {
	const at = raw.indexOf(":");
	if (at <= 0) {
		throw new UsageError(
			`--header must be "Name: value", got ${JSON.stringify(raw)}`,
		);
	}
	return [raw.slice(0, at).trim(), raw.slice(at + 1).trim()];
}

function toStringList(value: unknown): string[] {
	if (value === undefined) return [];
	return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

function resolveIo(io: CliIo): ResolvedIo {
	return {
		out: io.out ?? ((line) => console.log(line)),
		err: io.err ?? ((line) => console.error(line)),
		env: io.env ?? ((key) => Deno.env.get(key)),
		readStdin: io.readStdin ?? (() => new Response(Deno.stdin.readable).text()),
		isStdinTerminal: io.isStdinTerminal ?? (() => Deno.stdin.isTerminal()),
		readFile: io.readFile ?? ((path) => Deno.readFile(path)),
		readEnvFile: io.readEnvFile ?? defaultReadEnvFile,
		fetch: io.fetch,
	};
}

function defaultReadEnvFile(path: string): Record<string, string> {
	// `loadSync` ignores a missing file, which would turn a mistyped --env-file into a
	// confusing "no topic" further down. A file that was asked for by name must exist.
	try {
		Deno.statSync(path);
	} catch {
		throw new NtfyConfigError(`--env-file: cannot read ${path}`);
	}
	return loadSync({ envPath: path, export: false });
}

/**
 * Run the CLI. Returns the process exit code; never exits the process itself.
 *
 * @param args Raw argv, without the executable (i.e. `Deno.args`).
 * @param io Injectable side effects; see {@link CliIo}.
 */
export async function runCli(args: string[], io: CliIo = {}): Promise<number> {
	const resolved = resolveIo(io);
	const { out, err } = resolved;

	let flags;
	try {
		flags = parseArgs(args, {
			string: [
				"title",
				"topic",
				"server",
				"token",
				"user",
				"password",
				"tags",
				"click",
				"icon",
				"attach",
				"filename",
				"file",
				"action",
				"delay",
				"email",
				"call",
				"sequence-id",
				"timeout",
				"priority",
				"transport",
				"env-file",
				"header",
			],
			boolean: [
				"help",
				"version",
				"markdown",
				"quiet",
				"verbose",
				"dry-run",
				"stdin",
				"cache",
				"firebase",
			],
			collect: ["action", "header"],
			negatable: ["cache", "firebase"],
			alias: {
				h: "help",
				V: "version",
				t: "title",
				p: "priority",
				T: "topic",
				s: "server",
				k: "token",
				u: "user",
				c: "click",
				m: "markdown",
				f: "file",
				a: "action",
				d: "delay",
				e: "email",
				H: "header",
				n: "dry-run",
				q: "quiet",
				v: "verbose",
			},
			default: { cache: true, firebase: true },
			unknown: (arg) => {
				if (arg.startsWith("-") && arg !== "-") {
					throw new UsageError(`unknown option: ${arg}`);
				}
				return true;
			},
		});
	} catch (e) {
		if (e instanceof UsageError) {
			err(e.message);
			err(`Try \`${BIN} --help\`.`);
			return 2;
		}
		throw e;
	}

	if (flags.help) {
		out(HELP);
		return 0;
	}
	if (flags.version) {
		out(VERSION);
		return 0;
	}
	// A human typing the bare command wants to know what it does, not an error.
	if (args.length === 0 && resolved.isStdinTerminal()) {
		out(HELP);
		return 0;
	}

	try {
		return await send(flags, resolved);
	} catch (e) {
		if (e instanceof UsageError) {
			err(e.message);
			err(`Try \`${BIN} --help\`.`);
			return 2;
		}
		if (e instanceof NtfyConfigError) {
			err(e.message);
			return 2;
		}
		err(e instanceof Error ? e.message : String(e));
		return 2;
	}
}

// deno-lint-ignore no-explicit-any
async function send(flags: any, io: ResolvedIo): Promise<number> {
	const positional = flags._.map((v: unknown) => String(v));

	let env = io.env;
	if (flags["env-file"]) {
		const fromFile = io.readEnvFile(String(flags["env-file"]));
		const ambient = io.env;
		// The real environment wins: a checked-in .env is a default, not an override.
		env = (key: string) => ambient(key) ?? fromFile[key];
	}

	const options: NtfyOptions = { ...optionsFromEnv(env) };

	// --stdin is explicit; otherwise stdin is only read when there is nothing typed and
	// something is actually piped in. A trailing newline from a pipe is noise, not content.
	let message: string | undefined;
	if (flags.stdin) message = (await io.readStdin()).replace(/\s+$/, "");
	else if (positional.length) message = positional.join(" ");
	else if (!io.isStdinTerminal()) message = (await io.readStdin()).replace(/\s+$/, "");

	if (message === undefined && !flags.file && !flags.attach) {
		throw new UsageError(
			"nothing to send: give a message, pipe one in, or attach a file",
		);
	}
	if (message !== undefined) options.message = message;

	if (flags.title) options.title = String(flags.title);
	if (flags.topic) options.topic = String(flags.topic);
	if (flags.server) options.server = String(flags.server);
	if (flags.token) options.token = String(flags.token);
	if (flags.user) {
		const { username, password } = splitUser(String(flags.user));
		options.username = username;
		if (password !== undefined) options.password = password;
	}
	if (flags.password) options.password = String(flags.password);
	if (flags.priority) {
		options.priority = String(flags.priority) as NtfyOptions["priority"];
	}
	if (flags.tags) options.tags = String(flags.tags);
	if (flags.click) options.click = String(flags.click);
	if (flags.markdown) options.markdown = true;
	if (flags.icon) options.icon = String(flags.icon);
	if (flags.attach) options.attach = String(flags.attach);
	if (flags.filename) options.filename = String(flags.filename);
	if (flags.delay) options.delay = String(flags.delay);
	if (flags.email) options.email = String(flags.email);
	if (flags.call) options.call = String(flags.call);
	if (flags.cache === false) options.cache = false;
	if (flags.firebase === false) options.firebase = false;
	if (flags["sequence-id"]) options.sequenceId = String(flags["sequence-id"]);
	if (flags.transport) {
		const transport = String(flags.transport);
		if (!["auto", "json", "body"].includes(transport)) {
			throw new UsageError(
				`--transport must be auto, json or body, got ${transport}`,
			);
		}
		options.transport = transport as NtfyTransport;
	}
	if (flags.timeout) {
		const ms = Number(flags.timeout);
		if (!Number.isFinite(ms) || ms < 0) {
			throw new UsageError(`--timeout must be a number of milliseconds`);
		}
		options.timeout = ms;
	}

	const actions = toStringList(flags.action);
	if (actions.length) options.actions = actions.join("; ");

	const headers = toStringList(flags.header);
	if (headers.length) {
		options.headers = Object.fromEntries(headers.map(parseHeaderFlag));
	}

	if (flags.file) {
		const path = String(flags.file);
		options.attachment = await io.readFile(path);
		if (!options.filename) options.filename = basename(path);
	}

	if (flags["dry-run"]) options.dryRun = true;
	if (io.fetch) options.fetch = io.fetch;
	// The CLI reports failures itself, in its own voice.
	options.logger = false;

	const result = await ntfySend(options);

	if (result.dryRun && result.request) {
		io.out(`Would send (nothing was sent):`);
		for (const line of describeRequest(result.request)) io.out(line);
		return 0;
	}

	if (!result.ok) {
		io.err(`${BIN}: ${result.error ?? "failed"}`);
		if (flags.verbose && result.request) {
			for (const line of describeRequest(result.request)) io.err(line);
		}
		return result.status === 0 && !result.request ? 2 : 1;
	}

	if (flags.verbose && result.request) {
		for (const line of describeRequest(result.request)) io.out(line);
		if (result.message) io.out(JSON.stringify(result.message, null, 2));
	}
	if (!flags.quiet) {
		const where = result.request ? redactUrl(result.request.url) : "ntfy";
		const id = result.message?.id ? ` (id ${result.message.id})` : "";
		io.out(`sent to ${where}${id}`);
	}
	return 0;
}
