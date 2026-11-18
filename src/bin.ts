#!/usr/bin/env node

// npm `bin` entry (`mmntfy`). Runs the CLI unconditionally: a bin must never silently do
// nothing. Sets `process.exitCode` rather than calling `process.exit`, so buffered stdout is
// flushed.
import process from "node:process";
import { runCli } from "./cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
