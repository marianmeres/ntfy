/**
 * `@marianmeres/ntfy` — runtime-agnostic core (the npm package's `.` entry).
 *
 * One function to send an [ntfy](https://ntfy.sh) notification, everything ntfy's publish API
 * can carry, and nothing that reads your environment behind your back:
 *
 * ```ts
 * import { ntfy } from "@marianmeres/ntfy";
 *
 * await ntfy({ topic: "alerts", message: "backup finished" });
 * ```
 *
 * Deno-only pieces — `ntfySync` (blocking, for exit handlers) and the CLI — live in
 * {@link "./main.ts"}, the JSR entry.
 *
 * @module
 */

export * from "./types.ts";
export * from "./target.ts";
export * from "./request.ts";
export * from "./ntfy.ts";
export * from "./env.ts";
