# @marianmeres/ntfy — Agent Guide

One function and one command to publish an [ntfy](https://ntfy.sh) notification.
Complete publish API, validated locally before anything is sent, never throws by
default. Library + CLI. **Publish only — this package does not subscribe.**

## Quick Reference

- **Stack:** TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`,
  Biome. Runtime policy: Node at the keyboard and in production, npm as the registry; no
  `Deno.*` / `Bun.*`, no `jsr:` / `npm:` specifiers in source.
- **npm** (`package.json`, manifest of record; built by `tsc -p tsconfig.build.json`):
  `.` → `src/mod.ts` (browser-safe core), `./sync` → `src/sync.ts`, bin `mmntfy` →
  `src/bin.ts`.
- **JSR** (`jsr.json`, kept for the Deno consumers): `.` → `src/main.ts` (re-exports
  `mod.ts` + `sync.ts`; its `import.meta.main` guard runs `cli.ts`), `./sync` →
  `src/sync.ts`. No version field: `publish:jsr` passes the `package.json` one.
- **CLI binary:** `mmntfy` — deliberately **not** `ntfy`, which is ntfy's own Go CLI.
- **Install:** `pnpm install` | **Test:** `pnpm test` (offline — `fetch` is injected,
  the curl path and the e2e CLI talk to a subprocess server on loopback) |
  **Check all:** `pnpm run ci` (typecheck + Biome + tests + npm smoke) |
  **Format:** `pnpm run format`.
- **Deno side:** `pnpm run test:deno` runs the same suite on Deno (`CLI_RUNTIME=deno`
  starts the CLI from `src/main.ts`); `pnpm run jsr:check` is a publish dry run.
- **Try it (dry):** `pnpm run cli -n -T alerts "hello"` — `-n` builds and prints the
  request, sends nothing, needs no credentials.
- **Try it (live):** `pnpm run send "hello"` — loads `.env` (gitignored; see
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
- **I/O layer:** `ntfy.ts` (async `fetch`), `sync.ts` (blocking `curl` via
  `node:child_process` `spawnSync`; not browser-safe, hence its own export).
- **CLI layer:** `cli.ts` (`runCli(args, io)` — all side effects injectable via
  `CliIo`; defaults use `node:util` `parseArgs`/`parseEnv`, `node:fs`, `node:tty`),
  entered through `bin.ts` (npm) or `main.ts` (JSR).
- **Deps:** `@marianmeres/clog` (failure logging) — the only runtime dependency.

## Project Structure

```
src/
  types.ts     all public types, errors, ntfy's own limits as constants
  target.ts    resolveTarget / jsonUrl / topicUrl — the four target spellings
  request.ts   buildNtfyRequest + normalize*/encodeHeaderValue; ALL validation
  ntfy.ts      ntfySend, ntfy, createNtfy, createNtfySend, mergeOptions
  sync.ts      ntfySendSync, ntfySync, haveCurl (curl subprocess)   → npm/JSR ./sync
  env.ts       optionsFromEnv(EnvGetter), ENV_VARS
  cli.ts       runCli — the ONLY layer that reads the ambient environment
  version.ts   VERSION for --version; written from package.json on release
  mod.ts       npm "." (core)   bin.ts  npm bin   main.ts  JSR "." (core + sync + CLI guard)
tests/
  *.test.ts            one per module; cli.test.ts injects the whole of CliIo
  cli.e2e.test.ts      spawns the real CLI (bin.ts; main.ts on Deno) — real env, stdin,
                       files, fetch against the assert server
  version.test.ts      src/version.ts agrees with package.json
  _assert-server.ts    subprocess HTTP server that asserts on what it receives
                       (ntfySync blocks the event loop, so the receiving server cannot
                       live in the same process)
  _runtime.ts          starts subprocesses on Node, or on Deno under CLI_RUNTIME=deno
scripts/
  smoke-npm.ts         packs + installs the tarball, runs the bin, imports both exports,
                       fails if the "." graph imports any node:* builtin (part of ci)
  sync-version.ts      package.json version → src/version.ts (release --before-commit)
```

## Critical Conventions

1. **The library reads no environment.** `NTFY_*` is the CLI's vocabulary. In code,
   the caller opts in: `createNtfy(optionsFromEnv((k) => process.env[k]))`. Do not add an
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
6. **`runCli` never calls `process.exit`.** It returns an exit code; `bin.ts` /
   `main.ts` set `process.exitCode`, so stdout is flushed. Every side effect goes through
   `CliIo`.
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

## CLI Parsing Notes

- `node:util` `parseArgs`, strict: an unknown option, an option missing its value, or a
  value starting with `-` (`-t -5`) exits 2 with Node's own message; `--title=-5` and
  `-- -5 degrees` are the escapes. `allowNegative` gives `--no-cache` / `--no-firebase`.
- `--env-file` is parsed by `util.parseEnv` (Node's `--env-file` rules: no `${VAR}`
  expansion); a leading BOM is dropped.
- **Node trap:** Node scans the _script's_ arguments for `--env-file` too. It never loads
  such a file, but a missing one makes Node exit **9** (`node: x.env: not found`) before
  the CLI runs; Deno reaches the CLI's own exit 2. `tests/cli.e2e.test.ts` accepts both.

## Before Making Changes

- [ ] Adding a publish field? `types.ts` → `normalize()` → **both** `buildJsonRequest`
      and `buildBodyRequest` → CLI flag + help → `API.md`/`README.md` → a test that
      asserts it reaches the payload.
- [ ] Verify any ntfy behaviour against
      `https://raw.githubusercontent.com/binwiederhier/ntfy/main/server/server.go`
      (`parsePublishParams`, `transformBodyJSON`) — the published docs are incomplete.
- [ ] `pnpm run format`, then `pnpm run ci`. Touching `sync.ts`, `cli.ts` or `main.ts`?
      Also `pnpm run test:deno` — Deno consumers import the JSR build.
- [ ] Keep `src/mod.ts`'s graph free of `node:*` imports (the smoke test fails on one);
      anything that needs a builtin goes in a separate export, like `./sync`.
- [ ] Releasing is a human action: `pnpm run rp` / `rpm` (bump via
      `@marianmeres/release`, sync `src/version.ts`, then npm + JSR publish).

## Documentation Index

- [README.md](./README.md) — overview, installation, CLI usage
- [API.md](./API.md) — complete API reference
- [.env.example](./.env.example) — the CLI's `NTFY_*` vocabulary
