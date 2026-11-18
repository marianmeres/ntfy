/**
 * `@marianmeres/ntfy` — the browser-safe core (the npm package's `.` entry).
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
 * Nothing here goes beyond web standards (`fetch`, `URL`, `TextEncoder`), so it runs on Node,
 * Deno and in the browser alike. The blocking sender — `ntfySync`, for exit handlers — needs
 * `node:child_process` and lives in {@link "./sync.ts"} (`@marianmeres/ntfy/sync`); the CLI is
 * the `mmntfy` bin.
 *
 * @module
 */

export * from "./env.ts";
export * from "./ntfy.ts";
export * from "./request.ts";
export * from "./target.ts";
export * from "./types.ts";
