/**
 * JSR entry point for `@marianmeres/ntfy`: library + CLI.
 *
 * Re-exports the runtime-agnostic core from {@link "./mod.ts"} plus the Deno-only synchronous
 * sender from {@link "./sync.ts"}, and — when run directly — the CLI:
 *
 * ```bash
 * deno run -A jsr:@marianmeres/ntfy "backup finished"
 * deno install -gA -n mmntfy jsr:@marianmeres/ntfy
 * ```
 *
 * Importing this module as a dependency has no side effects: `import.meta.main` is `false`, so
 * the CLI (and its Deno-only dependencies) is never loaded.
 *
 * The npm package is built from {@link "./mod.ts"} only.
 *
 * @module
 */

export * from "./mod.ts";
export * from "./sync.ts";

if (import.meta.main) {
	const { runCli } = await import("./cli.ts");
	Deno.exit(await runCli(Deno.args));
}
