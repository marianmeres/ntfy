/**
 * JSR entry point for `@marianmeres/ntfy`: library + CLI.
 *
 * Re-exports the browser-safe core from {@link "./mod.ts"} plus the blocking sender from
 * {@link "./sync.ts"}, and — when run directly — the CLI:
 *
 * ```bash
 * deno run -A jsr:@marianmeres/ntfy "backup finished"
 * deno install -gA -n mmntfy jsr:@marianmeres/ntfy
 * ```
 *
 * Importing this module as a dependency has no side effects: `import.meta.main` is `false`, so
 * the CLI module is never loaded.
 *
 * The npm package does not ship this file: its `.` export is {@link "./mod.ts"}, its `./sync`
 * export is {@link "./sync.ts"}, and its `mmntfy` bin is `bin.ts`.
 *
 * @module
 */

import process from "node:process";

export * from "./mod.ts";
export * from "./sync.ts";

// Run as a CLI only when this module is the program entrypoint.
if (import.meta.main) {
	const { runCli } = await import("./cli.ts");
	process.exitCode = await runCli(process.argv.slice(2));
}
