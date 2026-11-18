/**
 * A one-request HTTP server that *validates* what it receives, run as a subprocess.
 *
 * `ntfySync` blocks the event loop by design (that is the whole point of it), so a receiving
 * server cannot live in the same process as the test. Putting the assertions in the server and
 * answering 200 only when they all hold turns "did curl send the right thing" into an exit code
 * the parent can simply check.
 *
 * Prints `READY <port>` on stdout, then one JSON line per request it handled.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { text } from "node:stream/consumers";

const expected = JSON.parse(process.argv[2] ?? "{}") as {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const body = await text(request);
	const problems: string[] = [];

	if (expected.method && request.method !== expected.method) {
		problems.push(`method: want ${expected.method}, got ${request.method}`);
	}
	if (expected.path && url.pathname !== expected.path) {
		problems.push(`path: want ${expected.path}, got ${url.pathname}`);
	}
	for (const [name, value] of Object.entries(expected.headers ?? {})) {
		const raw = request.headers[name.toLowerCase()];
		const actual = Array.isArray(raw) ? raw.join(", ") : (raw ?? null);
		if (actual !== value) problems.push(`${name}: want ${value}, got ${actual}`);
	}
	if (expected.body !== undefined && body !== expected.body) {
		problems.push(`body: want ${expected.body}, got ${body}`);
	}

	console.log(JSON.stringify({ problems }));

	response.setHeader("content-type", "application/json");
	if (problems.length) {
		response.statusCode = 400;
		response.end(
			JSON.stringify({ code: 40001, http: 400, error: problems.join(" · ") }),
		);
		return;
	}
	response.statusCode = 200;
	response.end(
		JSON.stringify({ id: "sync123", time: 1, event: "message", topic: "alerts" }),
	);
});

server.listen(0, "127.0.0.1", () => {
	console.log(`READY ${(server.address() as AddressInfo).port}`);
});

process.on("SIGTERM", () => {
	server.close();
	process.exit(0);
});
