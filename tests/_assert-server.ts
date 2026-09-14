/**
 * A one-request HTTP server that *validates* what it receives, run as a subprocess.
 *
 * `ntfySync` blocks the event loop by design (that is the whole point of it), so a receiving
 * server cannot live in the same isolate as the test. Putting the assertions in the server and
 * answering 200 only when they all hold turns "did curl send the right thing" into an exit code
 * the parent can simply check.
 *
 * Prints `READY <port>` on stdout, then one JSON line per request it handled.
 */

const expected = JSON.parse(Deno.args[0] ?? "{}") as {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
};

const server = Deno.serve({
	port: 0,
	hostname: "127.0.0.1",
	onListen: ({ port }) => console.log(`READY ${port}`),
}, async (request) => {
	const url = new URL(request.url);
	const body = await request.text();
	const problems: string[] = [];

	if (expected.method && request.method !== expected.method) {
		problems.push(`method: want ${expected.method}, got ${request.method}`);
	}
	if (expected.path && url.pathname !== expected.path) {
		problems.push(`path: want ${expected.path}, got ${url.pathname}`);
	}
	for (const [name, value] of Object.entries(expected.headers ?? {})) {
		const actual = request.headers.get(name);
		if (actual !== value) problems.push(`${name}: want ${value}, got ${actual}`);
	}
	if (expected.body !== undefined && body !== expected.body) {
		problems.push(`body: want ${expected.body}, got ${body}`);
	}

	console.log(JSON.stringify({ problems }));

	if (problems.length) {
		return new Response(
			JSON.stringify({ code: 40001, http: 400, error: problems.join(" · ") }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}
	return new Response(
		JSON.stringify({ id: "sync123", time: 1, event: "message", topic: "alerts" }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
});

Deno.addSignalListener("SIGTERM", () => {
	server.shutdown();
	Deno.exit(0);
});
