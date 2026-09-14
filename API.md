# API

`@marianmeres/ntfy` publishes to [ntfy](https://ntfy.sh). It does not subscribe.

Two entry points:

| Entry         | Contains                                                      | Available on |
| ------------- | ------------------------------------------------------------- | ------------ |
| `src/mod.ts`  | `ntfy`, `ntfySend`, `createNtfy`, builder, types, env reader  | JSR + npm    |
| `src/main.ts` | all of the above **plus** `ntfySync`, `ntfySendSync`, the CLI | JSR only     |

`deno add jsr:@marianmeres/ntfy` gives you `main.ts`; `npm install @marianmeres/ntfy`
gives you `mod.ts` (the pieces that need `Deno.Command` or `@std/*` are not in it).

---

## Functions

### `ntfy(options)`

Send one message. Resolves `true` if ntfy accepted it.

**Parameters:**

- `options` (`NtfyOptions | string`) — a bare string is shorthand for `{ message }`,
  which is only useful together with `createNtfy`.

**Returns:** `Promise<boolean>`

**Example:**

```typescript
await ntfy({ topic: "alerts", message: "backup finished" });
```

Does not throw unless `throwOnError` is set: a notification is a side channel, and an
unreachable server must not be able to change what the program it is watching decides
to do. Failures are logged instead — see `logger`.

---

### `ntfySend(options)`

`ntfy`, reporting everything that happened.

**Parameters:**

- `options` (`NtfyOptions | string`)

**Returns:** `Promise<NtfyResult>`

**Example:**

```typescript
const result = await ntfySend({ topic: "alerts", message: "hi", token: "wrong" });
if (!result.ok) {
	console.error(result.status, result.error, result.errorCode);
	// 401  HTTP 401 — unauthorized  40101
}
```

---

### `createNtfy(defaults)`

Bind default options once and send with a string afterwards. Per-call options win,
field by field (`headers` are merged).

**Parameters:**

- `defaults` (`NtfyOptions`)

**Returns:** `(options: NtfyOptions | string) => Promise<boolean>`

**Example:**

```typescript
const notify = createNtfy({ topic: "alerts", token: myToken, tags: ["robot"] });

await notify("deploy finished");
await notify({ message: "deploy failed", priority: 5, tags: ["rotating_light"] });
```

---

### `createNtfySend(defaults)`

As `createNtfy`, returning the full `NtfyResult`.

**Returns:** `(options: NtfyOptions | string) => Promise<NtfyResult>`

---

### `ntfySync(options)` — Deno only

Send one message, **blocking** until it is delivered or has failed, by shelling out to
`curl`. Returns `true` if curl was happy.

This exists for the places `fetch` cannot reach: a synchronous `Deno.exit()`, an
`unload` listener, a signal handler's shutdown deadline. The event loop does not turn
while it runs — which is the point.

**Requires:** `curl` on `PATH` and the `--allow-run=curl` permission. Uploading a file
is not supported here; use `ntfySend`.

**Returns:** `boolean`

**Example:**

```typescript
globalThis.addEventListener("unload", () => {
	ntfySync({ topic: "alerts", message: "process exited", priority: 4 });
});
```

> The token is passed as a curl argument, so it is visible in the process table for
> the life of the request. curl can only be kept from that by a config file or stdin,
> and stdin is what a synchronous subprocess cannot have. Give the sender a
> publish-only token.

---

### `ntfySendSync(options)` — Deno only

`ntfySync`, reporting the full `NtfyResult`.

**Returns:** `NtfyResult`

---

### `haveCurl()` — Deno only

Is `curl` on `PATH`? Ask once, at startup, so a program configured to notify can
refuse to start rather than fail silently later.

**Returns:** `boolean`

---

### `buildNtfyRequest(options)`

Build and validate the HTTP request a set of options describes, without sending it.
Pure. This is all `dryRun` does.

**Parameters:**

- `options` (`NtfyOptions | string`)

**Returns:** `NtfyRequest`

**Throws:** `NtfyConfigError`

**Example:**

```typescript
const request = buildNtfyRequest({ topic: "alerts", message: "hi" });
// { method: "POST", url: "https://ntfy.sh/", transport: "json",
//   headers: { "Content-Type": "application/json" },
//   body: '{"topic":"alerts","message":"hi"}' }
```

---

### `optionsFromEnv(env)`

Read `NTFY_*` into options. Pure: the environment arrives as a getter.

**Parameters:**

- `env` (`EnvGetter`) — `(key: string) => string | undefined`. `Deno.env.get` and
  `(k) => process.env[k]` both fit.

**Returns:** `NtfyOptions` — only the fields that were actually set. Unset and empty
mean the same thing.

**Throws:** `NtfyConfigError` when a variable is set to something unusable, so a typo
is found at startup rather than at 4am.

Reads: `NTFY_TOPIC`, `NTFY_SERVER`, `NTFY_TOKEN`, `NTFY_USERNAME`, `NTFY_PASSWORD`,
`NTFY_PRIORITY`, `NTFY_TAGS`, `NTFY_TITLE`, `NTFY_ICON`, `NTFY_CLICK`, `NTFY_TIMEOUT`
(also listed in `ENV_VARS`).

**Example:**

```typescript
const notify = createNtfy(optionsFromEnv(Deno.env.get));
```

---

### `resolveTarget(options)`

Resolve `{ server, topic }` into the two URLs the transports use.

**Parameters:**

- `options` (`{ server?: string; topic?: string }`)

**Returns:** `NtfyTarget` — `{ base, topic, search }`

**Throws:** `NtfyConfigError`

All of these resolve to the same place, because all of them are what someone means by
"send it here":

```typescript
resolveTarget({ topic: "alerts" });
resolveTarget({ topic: "ntfy.sh/alerts" });
resolveTarget({ topic: "https://ntfy.sh/alerts" });
resolveTarget({ topic: "alerts", server: "https://ntfy.sh" });
resolveTarget({ server: "https://ntfy.sh/alerts" });
```

A sub-path is kept (`https://example.com/ntfy/alerts` → base `https://example.com/ntfy`)
and a `?auth=` query string is carried onto both URLs.

Companions: `jsonUrl(target)` (the server root) and `topicUrl(target)`.

---

### `normalizePriority(value)` · `normalizeTags(value)` · `normalizeDelay(value)`

The validators `buildNtfyRequest` uses, exported for pre-flight checks of untrusted
input (a CLI flag, a config file).

```typescript
normalizePriority("urgent"); // 5
normalizePriority("5"); // 5
normalizeTags("a, b ,,c"); // ["a", "b", "c"]
normalizeDelay(new Date("2026-01-01")); // "1767225600"
normalizeDelay(Date.now()); // throws: looks like milliseconds
```

---

### `encodeHeaderValue(value)`

RFC 2047 base64 encoding of a header value, applied to every `X-*` header on the body
transport so a non-ASCII title arrives as itself rather than as `?????`.

**Returns:** `string` — the input unchanged when it is already printable ASCII.

---

### `runCli(args, io?)` — Deno only

The CLI as a function. Returns the exit code; never calls `Deno.exit`. Every side
effect is injectable through `io` (`CliIo`: `out`, `err`, `env`, `readStdin`,
`isStdinTerminal`, `readFile`, `readEnvFile`, `fetch`), which is how it is tested
without spawning a process.

**Returns:** `Promise<number>` — `0` sent, `1` not sent, `2` bad usage or configuration.

---

## Types

### `NtfyOptions`

```typescript
interface NtfyOptions {
	// What to say
	message?: string; // ntfy substitutes "triggered" when empty
	title?: string; // max 1 KB
	priority?: 1 | 2 | 3 | 4 | 5 | "min" | "low" | "default" | "high" | "max" | "urgent";
	tags?: string[] | string; // emoji shortcodes render as emoji; max 512 bytes total
	click?: string; // URL opened on tap
	markdown?: boolean;
	icon?: string; // http(s) URL of a JPEG/PNG
	actions?: NtfyAction[] | string; // max 3; a string is ntfy's short format

	// Attachments
	attach?: string; // external file, by http(s) URL
	attachment?: Uint8Array | ArrayBuffer | Blob; // local file bytes to upload
	filename?: string; // name shown on the client

	// Delivery
	delay?: string | number | Date; // "30m", "9am", a Date, or unix *seconds*
	email?: string; // address, or "yes"
	call?: string; // phone number, or "yes"
	cache?: boolean; // false → do not cache server-side
	firebase?: boolean; // false → do not forward to Firebase
	sequenceId?: string; // for later updating/deleting this notification

	// Where
	topic?: string; // topic, host/topic, or a full URL
	server?: string; // default https://ntfy.sh
	token?: string; // Authorization: Bearer
	username?: string; // ...or basic auth
	password?: string;
	headers?: Record<string, string>; // merged last

	// How
	transport?: "auto" | "json" | "body";
	timeout?: number; // ms, default 10000
	signal?: AbortSignal;
	throwOnError?: boolean; // default false
	dryRun?: boolean; // build and validate, send nothing
	fetch?: typeof globalThis.fetch;
	logger?: NtfyLogger | false; // where a swallowed failure is reported
}
```

`topic` is the only field that is effectively required, and it may carry the server
with it.

---

### `NtfyResult`

```typescript
interface NtfyResult {
	ok: boolean;
	status: number; // 0 when the request never completed
	request?: NtfyRequest; // what was built — present even on failure
	message?: NtfyMessage; // the server's echo, on success
	error?: string; // one-line reason
	errorCode?: number; // ntfy's own numeric code
	dryRun?: boolean;
}
```

---

### `NtfyRequest`

```typescript
interface NtfyRequest {
	method: "POST" | "PUT";
	url: string;
	headers: Record<string, string>;
	body: string | Uint8Array | ArrayBuffer | Blob | undefined;
	transport: "json" | "body";
}
```

---

### `NtfyAction`

```typescript
type NtfyAction =
	| { action: "view"; label: string; url: string; clear?: boolean }
	| {
		action: "http";
		label: string;
		url: string;
		method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
		headers?: Record<string, string>;
		body?: string;
		clear?: boolean;
	}
	| {
		action: "broadcast";
		label: string;
		intent?: string;
		extras?: Record<string, string>;
		clear?: boolean;
	}
	| { action: "copy"; label: string; value: string; clear?: boolean };
```

`actions` also accepts ntfy's short format as a string, which the server parses
itself:

```typescript
actions: "view, Open logs, https://ci.example.com/logs; copy, Copy id, abc123";
```

---

### `NtfyTarget`

```typescript
interface NtfyTarget {
	base: string; // "https://ntfy.sh" — server root, sub-path kept, no trailing slash
	topic: string; // "alerts"
	search: string; // "?auth=…" or ""
}
```

---

### `NtfyTransport`

```typescript
type NtfyTransport = "auto" | "json" | "body";
```

- **`json`** — one JSON object POSTed to the server root. UTF-8 clean (no header
  encoding), structured actions. The default for ordinary messages.
- **`body`** — the message (or an uploaded file) as the request body, everything else
  as `X-*` headers, RFC 2047 encoded where needed. The only transport that can carry
  an upload, a short-format actions string, or a message over 4,096 bytes — which ntfy
  then turns into an attachment.
- **`auto`** — `body` when one of those three applies, `json` otherwise.

Setting `transport: "json"` explicitly turns those three cases into a
`NtfyConfigError` that says which one it was, rather than letting ntfy answer 400.

---

### `NtfyLogger`

```typescript
interface NtfyLogger {
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}
```

`console` satisfies it, and so does a [`clog`](https://jsr.io/@marianmeres/clog)
instance — which is the default (namespace `ntfy`). `logger: false` silences it, and
is a deliberate choice: the return value then becomes the only trace a failed send
leaves.

---

## Errors

### `NtfyConfigError`

A message that could never be sent as written: no topic, a priority of `7`, a fourth
action button, a delayed e-mail. Deterministic and independent of the network.

Returned as `result.error` by default; thrown when `throwOnError` is set, and always
thrown by `buildNtfyRequest` / `resolveTarget` / the `normalize*` helpers.

### `NtfyError`

A message the server refused, or that never reached it. Only thrown when
`throwOnError` is set.

```typescript
class NtfyError extends Error {
	status: number; // HTTP status, or 0 if the request never completed
	code?: number; // ntfy's own numeric error code
	url?: string;
}
```

---

## Constants

### `DEFAULT_SERVER`

`"https://ntfy.sh"`

### `DEFAULT_TIMEOUT`

`10000` — milliseconds.

### `MESSAGE_SIZE_LIMIT`

`4096` — bytes of `message` ntfy still treats as text. Above this it becomes an
attachment (on the body transport, which `auto` therefore switches to).

### `TITLE_SIZE_LIMIT` · `TAGS_SIZE_LIMIT` · `MAX_ACTIONS`

`1024` bytes · `512` bytes · `3` — ntfy's own limits, enforced locally.

### `TOPIC_REGEX`

`/^[A-Za-z0-9_-]{1,64}$/` — ntfy's rule for what a topic may be made of.

### `ENV_VARS`

The `NTFY_*` names `optionsFromEnv` reads, in order.
