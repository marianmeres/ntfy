# @marianmeres/ntfy

[![NPM](https://img.shields.io/npm/v/@marianmeres/ntfy)](https://www.npmjs.com/package/@marianmeres/ntfy)
[![JSR](https://jsr.io/badges/@marianmeres/ntfy)](https://jsr.io/@marianmeres/ntfy)
[![License](https://img.shields.io/npm/l/@marianmeres/ntfy)](LICENSE)

One function — and one command — to send a push notification through
[ntfy](https://ntfy.sh).

```ts
await ntfy({ topic: "alerts", message: "backup finished" });
```

```bash
mmntfy "backup finished"
```

- **The whole publish API**, not a subset: title, priority, tags, click, markdown,
  icon, attachments (by URL or uploaded), action buttons, scheduled delivery, e-mail
  and phone forwarding, cache and Firebase toggles, sequence IDs.
- **Fails before it spends.** Every option is validated locally, so a bad topic, a
  fourth action button or a delayed e-mail is refused without a round trip — and
  `--dry-run` shows you exactly what would have gone out.
- **Never breaks the program it is watching.** A send returns `false` rather than
  throwing; an unreachable phone cannot change what your build script decides. A
  swallowed failure is still logged, so silence never quietly means success.
- **Picks the right wire format.** JSON publishing by default (UTF-8 clean,
  structured actions); it switches to the header transport by itself when you upload
  a file or pipe in a log over ntfy's 4 KB text limit — which ntfy then turns into an
  attachment instead of rejecting.
- **Sends from an exit handler.** `ntfySync()` blocks via `curl`, so a message still
  goes out from a synchronous `Deno.exit()` where `fetch` can never be awaited.
- **The library reads no environment.** `NTFY_*` belongs to the CLI; in code you pass
  options, or hand the environment in yourself.
- Library **and** CLI. Deno, Node and the browser.

## Installation

```bash
# Run the CLI with no install
deno run -A jsr:@marianmeres/ntfy --help

# Or install it as a command
deno install -gA -n mmntfy jsr:@marianmeres/ntfy

# As a library
deno add jsr:@marianmeres/ntfy     # Deno: core + ntfySync + CLI
npm install @marianmeres/ntfy      # npm: runtime-agnostic core only
```

The command is called `mmntfy`, not `ntfy`, so it never shadows
[ntfy's own CLI](https://docs.ntfy.sh/install/). Name it whatever you like with
`-n`.

## Usage

```ts
import { createNtfy, ntfy, ntfySend } from "@marianmeres/ntfy";

// The one-liner. `true` if ntfy took it.
await ntfy({ topic: "alerts", message: "backup finished" });

// Everything a notification can carry.
await ntfy({
	topic: "alerts",
	title: "Backup failed",
	message: "`/dev/sda1` is **full**.",
	markdown: true,
	priority: "max",
	tags: ["rotating_light", "floppy_disk"],
	click: "https://grafana.example.com/d/disks",
	actions: [
		{ action: "view", label: "Open logs", url: "https://ci.example.com/logs" },
		{
			action: "http",
			label: "Retry",
			url: "https://ci.example.com/retry",
			method: "POST",
		},
	],
	token: myToken,
});

// Bind the boring parts once.
const notify = createNtfy({ topic: "alerts", token: myToken, tags: ["robot"] });
await notify("deploy finished");
await notify({ message: "deploy failed", priority: 5 });

// When you need to know *why* it failed.
const result = await ntfySend({ topic: "alerts", message: "hi", token: "wrong" });
if (!result.ok) console.error(result.status, result.error); // 401 HTTP 401 — unauthorized (code 40101)
```

A failure is reported, never thrown — unless you ask:

```ts
await ntfy({ topic: "alerts", message: "hi", throwOnError: true }); // throws NtfyError
```

### From an exit handler (Deno)

`fetch` cannot be awaited from a synchronous `Deno.exit()`, an `unload` listener or a
signal handler's shutdown deadline. `ntfySync` shells out to `curl` and blocks, so a
message still goes out from all three:

```ts
import { haveCurl, ntfySync } from "@marianmeres/ntfy";

// Say "no message is coming" up front, not by silence at 4am.
if (!haveCurl()) throw new Error("notifications configured, but curl is missing");

globalThis.addEventListener("unload", () => {
	ntfySync({ topic: "alerts", message: "process exited", priority: 4 });
});
```

## CLI

```bash
mmntfy "backup finished"
mmntfy -t "Deploy" -p 4 --tags rocket,white_check_mark "shipped v1.2.3"
mmntfy -T https://ntfy.example.com/alerts -k tk_AgQd… "to a self-hosted server"
mmntfy -f screenshot.png "look at this"
mmntfy -a "view, Open logs, https://ci.example.com/logs" "build failed"
mmntfy -d "tomorrow, 9am" "stand-up"

# Pipe a log in. Over 4 KB it arrives as an attachment, which is ntfy's own behaviour.
make build 2>&1 | mmntfy -t "Build log" --tags hammer

# What would be sent? (nothing is, and the token is redacted)
mmntfy -n -t "Deploy" "shipped v1.2.3"
```

Exit codes: `0` sent · `1` not sent · `2` bad usage or configuration — so
`mmntfy … || echo "did not go out"` does what it looks like.

Run `mmntfy --help` for every flag.

### Configuration

The CLI — and only the CLI — reads the environment. Set these once and the common
case becomes `mmntfy "message"`:

| Variable                          | Flag               | Notes                                    |
| --------------------------------- | ------------------ | ---------------------------------------- |
| `NTFY_TOPIC`                      | `-T`, `--topic`    | Topic, `host/topic`, or a full URL       |
| `NTFY_SERVER`                     | `-s`, `--server`   | Default `https://ntfy.sh`                |
| `NTFY_TOKEN`                      | `-k`, `--token`    | Access token                             |
| `NTFY_USERNAME` / `NTFY_PASSWORD` | `-u`, `--user`     | Basic auth, as an alternative to a token |
| `NTFY_PRIORITY`                   | `-p`, `--priority` | `1`–`5` or `min`…`urgent`                |
| `NTFY_TAGS`                       | `--tags`           | Comma separated                          |
| `NTFY_TITLE`                      | `-t`, `--title`    |                                          |
| `NTFY_ICON` / `NTFY_CLICK`        | `--icon` / `-c`    |                                          |
| `NTFY_TIMEOUT`                    | `--timeout`        | Milliseconds, default `10000`            |

Flags beat the environment; the real environment beats a file given with
`--env-file`. See [.env.example](.env.example).

Working on this package? `deno task send "hello"` reads a local (gitignored) `.env`
and really sends; `deno task cli -n "hello"` builds the request and prints it without
sending anything.

In code, nothing is ambient — but you can opt in explicitly:

```ts
import { createNtfy, optionsFromEnv } from "@marianmeres/ntfy";

const notify = createNtfy(optionsFromEnv(Deno.env.get));
```

## API

See [API.md](API.md) for complete API documentation.

## License

[MIT](LICENSE)
