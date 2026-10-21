import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import { FocusTrace } from "./focus-diagnostics.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notify-dot-focus-test-"));
try {
	const filename = path.join(directory, "trace.jsonl");
	const trace = new FocusTrace(filename);
	const source = new EventEmitter();
	const buffer = new StdinBuffer();
	const chunks: string[] = [];
	source.on("data", (data: string) => { buffer.process(data); });
	buffer.on("data", (data: string) => { chunks.push(data); trace.record("extension", data); });
	const sourceListeners = source.listenerCount("data");
	const bufferListeners = buffer.listenerCount("data");
	trace.attach({ stdinBuffer: buffer } as unknown as Terminal, source as typeof process.stdin);
	trace.attach({ stdinBuffer: buffer } as unknown as Terminal, source as typeof process.stdin);
	assert.equal(trace.bufferAttached, true, "the actual supplied Pi buffer is observed");
	assert.equal(source.listenerCount("data"), sourceListeners + 1, "attachment is idempotent");
	assert.equal(buffer.listenerCount("data"), bufferListeners + 1);
	source.emit("data", "\x1b[");
	source.emit("data", "O");
	source.emit("data", "\x1b[I");
	source.emit("data", "do-not-record-this-text");
	for (const stage of ["raw", "buffer", "extension"] as const) {
		assert.equal(trace.counts[stage].focusOut, 1, `${stage} sees split focus-out`);
		assert.equal(trace.counts[stage].focusIn, 1, `${stage} sees focus-in`);
	}
	assert.equal(chunks.slice(0, 2).join(""), "\x1b[O\x1b[I", "observers do not consume or rewrite input");
	trace.dispose();
	trace.dispose();
	assert.equal(source.listenerCount("data"), sourceListeners, "raw observation is removed");
	assert.equal(buffer.listenerCount("data"), bufferListeners, "buffer observation is removed");
	const log = fs.readFileSync(filename, "utf8");
	assert.ok(!log.includes("do-not-record-this-text"), "typed contents are not persisted");
	const records = log.trim().split("\n").map(line => JSON.parse(line));
	assert.equal(records.at(-1).event, "summary");
	assert.equal(records.at(-1).counts.raw.focusIn, 1);
	const size = fs.statSync(filename).size;
	trace.record("raw", "\x1b[I");
	assert.equal(fs.statSync(filename).size, size, "late input cannot append after disposal");
	buffer.destroy();

	const missing = new FocusTrace(path.join(directory, "missing-buffer.jsonl"));
	missing.attach({} as Terminal, new EventEmitter() as typeof process.stdin);
	assert.equal(missing.bufferAttached, false, "unknown Pi internals are reported as unavailable");
	missing.dispose();
	console.log("focus-diagnostics: all assertions passed");
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}
