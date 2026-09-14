import { assertEquals, assertStringIncludes } from "@std/assert";
import { haveCurl, ntfySendSync, ntfySync } from "../src/main.ts";

const curl = haveCurl();

/** Start `_assert-server.ts` with the assertions it should apply, and wait for its port. */
async function startServer(expected: unknown): Promise<{
	port: number;
	stop: () => Promise<void>;
}> {
	const child = new Deno.Command(Deno.execPath(), {
		args: [
			"run",
			"--allow-net",
			new URL("./_assert-server.ts", import.meta.url).pathname,
			JSON.stringify(expected),
		],
		stdout: "piped",
		stderr: "null",
	}).spawn();

	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let port = 0;
	while (!port) {
		const { value, done } = await reader.read();
		if (done) throw new Error("assert-server exited before it was ready");
		buffered += decoder.decode(value, { stream: true });
		const match = buffered.match(/READY (\d+)/);
		if (match) port = Number(match[1]);
	}

	return {
		port,
		stop: async () => {
			await reader.cancel();
			try {
				child.kill("SIGKILL");
			} catch { /* already gone */ }
			await child.status;
		},
	};
}

Deno.test({
	name: "ntfySync sends a well-formed request, blocking, through curl",
	ignore: !curl,
	fn: async () => {
		const { port, stop } = await startServer({
			method: "POST",
			path: "/",
			headers: {
				"Content-Type": "application/json",
				"Authorization": "Bearer tk_test",
			},
			body: JSON.stringify({ topic: "alerts", message: "hello", title: "Ahoj" }),
		});
		try {
			const ok = ntfySync({
				server: `http://127.0.0.1:${port}`,
				topic: "alerts",
				message: "hello",
				title: "Ahoj",
				token: "tk_test",
				timeout: 5000,
				logger: false,
			});
			assertEquals(ok, true);
		} finally {
			await stop();
		}
	},
});

Deno.test({
	name: "ntfySync reports the server's own refusal rather than claiming success",
	ignore: !curl,
	fn: async () => {
		const { port, stop } = await startServer({ path: "/never-matches" });
		try {
			const result = ntfySendSync({
				server: `http://127.0.0.1:${port}`,
				topic: "alerts",
				message: "hello",
				timeout: 5000,
				logger: false,
			});
			assertEquals(result.ok, false);
			assertStringIncludes(result.error!, "curl exit 22");
		} finally {
			await stop();
		}
	},
});

Deno.test({
	name: "ntfySync reports an unreachable server instead of hanging",
	ignore: !curl,
	fn: () => {
		// Port 1 on loopback: nothing listens, and the connection is refused immediately.
		const result = ntfySendSync({
			server: "http://127.0.0.1:1",
			topic: "alerts",
			message: "hello",
			timeout: 3000,
			logger: false,
		});
		assertEquals(result.ok, false);
		assertStringIncludes(result.error!, "curl exit");
	},
});

Deno.test("ntfySync refuses an upload rather than pretending to send it", () => {
	const result = ntfySendSync({
		topic: "alerts",
		attachment: new Uint8Array([1, 2, 3]),
		logger: false,
	});
	assertEquals(result.ok, false);
	assertStringIncludes(result.error!, "cannot upload a file");
});

Deno.test("ntfySync validates before it spends anything", () => {
	const result = ntfySendSync({ message: "no topic", logger: false });
	assertEquals(result.ok, false);
	assertStringIncludes(result.error!, "no topic");
});

Deno.test("ntfySync honours dryRun", () => {
	const result = ntfySendSync({
		topic: "alerts",
		message: "hi",
		dryRun: true,
		logger: false,
	});
	assertEquals(result.ok, true);
	assertEquals(result.dryRun, true);
	assertEquals(result.request?.url, "https://ntfy.sh/");
});

Deno.test("haveCurl answers before a run commits to notifying", () => {
	assertEquals(typeof haveCurl(), "boolean");
});
