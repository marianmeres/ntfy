import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

// The npm artifact is the runtime-agnostic CORE only (mod.ts is its "." entry).
// sync.ts (Deno.Command + curl) and cli.ts (@std/cli, @std/dotenv, Deno globals) are
// Deno/JSR-only and are excluded.

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	sourceFiles: [
		"mod.ts",
		"types.ts",
		"target.ts",
		"request.ts",
		"ntfy.ts",
		"env.ts",
	],
	dependencies: versionizeDeps(["@marianmeres/clog"], denoJson),
});
