# @marianmeres/ntfy — Agent Guide

One function and one command to publish an [ntfy](https://ntfy.sh) notification.
Complete publish API, validated locally before anything is sent, never throws by
default. Library + CLI. **Publish only — this package does not subscribe.**

## Quick Reference

- **Runtime:** Deno. **JSR:** core + `ntfySync` + CLI. **npm:** core only.
- **JSR `exports` / CLI entry:** `src/main.ts` (re-exports `mod.ts` + `sync.ts`,
  `import.meta.main` guard runs `cli.ts`).
- **npm `.` entry:** `src/mod.ts` — no Deno globals, no `@std/*` (compiled by plain
  `tsc` via `@marianmeres/npmbuild`).
- **CLI binary:** `mmntfy` — deliberately **not** `ntfy`, which is ntfy's own Go CLI.
- **Test:** `deno task test` (`deno test -A`; offline — `fetch` is injected, and the
  curl path talks to a subprocess server on loopback).
- **Check / Lint / Format:** `deno task check` | `deno task lint` | `deno fmt`.
- **Try it (dry):** `deno task cli -n -T alerts "hello"` — `-n` builds and prints the
  request, sends nothing, needs no credentials.
- **Try it (live):** `deno task send "hello"` — loads `.env` (gitignored; see
  [.env.example](./.env.example)) and **really sends**. Add `-n` to rehearse it first.
  Verify what the server stored with
  `curl -s "https://ntfy.sh/<topic>/json?poll=1" | tail -1`.

## Architecture

```
NtfyOptions ──normalize+validate──▶ NtfyRequest ──┬── fetch ──────▶ NtfyResult
 (+ resolveTarget)                                │   (ntfy.ts)
                                                  └── curl ───────▶ NtfyResult
                                                      (sync.ts, blocking)
NTFY_* ──optionsFromEnv(getter)──▶ NtfyOptions        ▲
                                                      │
argv ──parseArgs──▶ NtfyOptions ──────────────────────┘  (cli.ts)
```

- **Pure core** (npm-safe): `types.ts`, `target.ts`, `request.ts`, `env.ts`.
  `buildNtfyRequest` is the only place options become a request, and the only place
  anything is validated — which is what makes `dryRun` a complete pre-flight rather
  than a partial one.
- **I/O layer:** `ntfy.ts` (async `fetch`), `sync.ts` (Deno-only, blocking `curl`).
- **Deno layer:** `cli.ts` (`runCli(args, io)` — all side effects injectable via
  `CliIo`), `main.ts`.
- **Deps:** `@marianmeres/clog` (failure logging), `@std/cli` + `@std/dotenv` +
  `@std/path` (CLI only).

## Project Structure

```
src/
  types.ts     all public types, errors, ntfy's own limits as constants
  target.ts    resolveTarget / jsonUrl / topicUrl — the four target spellings
  request.ts   buildNtfyRequest + normalize*/encodeHeaderValue; ALL validation
  ntfy.ts      ntfySend, ntfy, createNtfy, createNtfySend, mergeOptions
  sync.ts      Deno: ntfySendSync, ntfySync, haveCurl (curl subprocess)
  env.ts       optionsFromEnv(EnvGetter), ENV_VARS
  cli.ts       Deno: runCli — the ONLY layer that reads the ambient environment
  mod.ts       npm entry (core)        main.ts   JSR entry (core + sync + CLI guard)
tests/
  *.test.ts            one per module; cli.test.ts injects the whole of CliIo
  _assert-server.ts    subprocess HTTP server that asserts on what it receives,
                       used by sync.test.ts (ntfySync blocks the event loop, so the
                       receiving server cannot live in the same isolate)
```

## Critical Conventions

1. **The library reads no environment.** `NTFY_*` is the CLI's vocabulary. In code,
   the caller opts in: `createNtfy(optionsFromEnv(Deno.env.get))`. Do not add an
   ambient read to `ntfy()` — two libraries that both read `NTFY_TOPIC` on their own
   cannot be told apart when the wrong phone buzzes.
2. **Validate in `request.ts`, nowhere else.** Anything ntfy would reject with a 400
   is refused locally with a message that says which option and why. A check added
   elsewhere is a check `dryRun` does not run.
3. **Never throw by default.** `ntfy()`/`ntfySend()` return a failure; only
   `throwOnError: true` throws. A notification must not be able to change what the
   program it is watching decides to do.
4. **But never fail silently either.** A swallowed failure is logged through
   `NtfyOptions.logger` (default: `clog("ntfy")`). The moment a program notifies, _no
   message_ starts to mean "nothing happened" — a quiet failure turns that into a lie.
   `logger: false` is available and is the caller's choice.
5. **Transport is derived, not guessed.** `auto` picks `body` only for the three cases
   JSON publishing cannot carry (upload, short-format actions, message > 4,096 bytes).
   An explicit `transport: "json"` turns each of those into a named refusal.
6. **`runCli` never calls `Deno.exit`.** It returns an exit code; `main.ts` exits.
   Every side effect goes through `CliIo`.
7. **Secrets are redacted in anything printed** (`--dry-run`, `--verbose`): the
   `Authorization` header and any `?auth=` query parameter.

## ntfy API Notes (verified against the server source, not just the docs)

- JSON publishing **must** POST to the server _root_, not the topic URL.
- The JSON body also accepts `cache`, `firebase` and `sequence_id`, which ntfy's
  documented field table omits — its `transformBodyJSON` handler reads them.
- `X-UnifiedPush` and `X-Poll-ID` are header-only and are not modelled (both are for
  ntfy's own clients); pass them through `headers` if ever needed.
- An error body is `{"code","http","error","link"}` — the human-readable field is
  `error`, **not** `message`.
- On the body transport ntfy expands a literal `\n` in `X-Message` into a newline,
  which is why a multi-line message is folded that way. It is lossy for a message that
  already contained the two characters `\` `n`, and only applies when a file is
  attached.
- Limits enforced locally: message 4,096 bytes, title 1 KB, all tags 512 bytes,
  3 actions, topic `[-_A-Za-z0-9]{1,64}`.

## Before Making Changes

- [ ] Adding a publish field? `types.ts` → `normalize()` → **both** `buildJsonRequest`
      and `buildBodyRequest` → CLI flag + help → `API.md`/`README.md` → a test that
      asserts it reaches the payload.
- [ ] Verify any ntfy behaviour against
      `https://raw.githubusercontent.com/binwiederhier/ntfy/main/server/server.go`
      (`parsePublishParams`, `transformBodyJSON`) — the published docs are incomplete.
- [ ] `deno task check && deno task lint && deno task test && deno fmt`.
- [ ] Keep `src/mod.ts`'s graph free of Deno globals and `@std/*`, and keep
      `scripts/build-npm.ts`'s `sourceFiles` in sync with it.

## Documentation Index

- [README.md](./README.md) — overview, installation, CLI usage
- [API.md](./API.md) — complete API reference
- [.env.example](./.env.example) — the CLI's `NTFY_*` vocabulary
