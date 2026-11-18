/**
 * How the tests start a TypeScript subprocess (the assert server, the CLI).
 *
 * On Node — the reference runtime — by default. Under `CLI_RUNTIME=deno`
 * (`pnpm run test:deno`) on Deno instead, which is how the JSR build, the one Deno
 * consumers import, is checked before it is published.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Absolute path of a file relative to `tests/`. */
export const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** True when the subprocesses run on Deno (`CLI_RUNTIME=deno`). */
export const ON_DENO: boolean = process.env.CLI_RUNTIME === "deno";

/** The argv that runs `script` (an absolute path) on the selected runtime. */
export function runtimeArgv(script: string): [string, ...string[]] {
	return ON_DENO
		? ["deno", "run", "-A", "--no-lock", "--config", path("../jsr.json"), script]
		: [process.execPath, script];
}

/** Start `_assert-server.ts` with the assertions it should apply, and wait for its port. */
export async function startAssertServer(expected: unknown): Promise<{
	port: number;
	stop: () => Promise<void>;
}> {
	const [cmd, ...args] = runtimeArgv(path("./_assert-server.ts"));
	const child = spawn(cmd, [...args, JSON.stringify(expected)], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = once(child, "exit");

	// stdout stays drained after READY: the server logs every request it handles, and a
	// closed pipe would fail its writes.
	const port = await new Promise<number>((resolve, reject) => {
		let buffered = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			const match = buffered.match(/READY (\d+)/);
			if (match) resolve(Number(match[1]));
		});
		child.once("exit", () =>
			reject(new Error("assert-server exited before it was ready")),
		);
	});

	return {
		port,
		stop: async () => {
			child.kill("SIGKILL");
			await exited;
		},
	};
}
