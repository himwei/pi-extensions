import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notifyDot from "../notify-dot.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

const BASE = "π - s1 - proj";
const ENABLE = "\x1b[?1004h";
const DISABLE = "\x1b[?1004l";

// --- harness -------------------------------------------------------------
let now = 0;
const originalNow = Date.now;
Date.now = () => now;

const writes: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => {
	writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
	return true;
}) as typeof process.stdout.write;

function setProbe(value?: "present" | "away" | "unknown"): void {
	if (value === undefined) delete process.env.PI_NOTIFY_DOT_PROBE;
	else process.env.PI_NOTIFY_DOT_PROBE = value;
}

let handlers: Map<string, Handler> | undefined;
let inputHandler: InputHandler | undefined;
let inputUnsubbed = false;
let lastTitle: string | undefined;

function makeCtx(mode = "tui"): ExtensionContext {
	return {
		mode,
		cwd: "C:\\work\\proj",
		sessionManager: {
			getSessionName: () => "s1",
			getSessionId: () => "test-session",
			getCwd: () => "C:\\work\\proj",
		},
		ui: {
			setTitle: (title: string) => {
				lastTitle = title;
			},
			onTerminalInput: (handler: InputHandler) => {
				inputHandler = handler;
				return () => {
					inputUnsubbed = true;
				};
			},
		},
	} as unknown as ExtensionContext;
}

function boot(): void {
	handlers?.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, makeCtx());
	handlers = new Map();
	inputHandler = undefined;
	inputUnsubbed = false;
	lastTitle = undefined;
	setProbe(undefined);
	const pi = {
		on: (name: string, handler: Handler) => handlers!.set(name, handler),
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	notifyDot(pi);
}

const fire = (name: string, event: unknown, ctx = makeCtx()) => handlers!.get(name)!(event, ctx);
const input = (data: string) => inputHandler!(data);
const settle = (stopReason = "stop") => {
	fire("agent_end", { messages: [{ role: "assistant", stopReason }] });
	fire("agent_settled", { type: "agent_settled", aborted: false });
};

async function main(): Promise<void> {
	try {
	// Disabled by kill switch: no handlers registered at all.
	process.env.PI_NOTIFY_DOT = "off";
	{
		const pi = { on: () => assert.fail("must not register when disabled") } as unknown as ExtensionAPI;
		notifyDot(pi);
	}
	delete process.env.PI_NOTIFY_DOT;

	boot();
	// Startup: hooking happens lazily and enables 1004 focus reporting.
	assert.equal(inputHandler, undefined);
	fire("session_start", { type: "session_start", reason: "startup" });
	assert.ok(inputHandler, "raw input hook installed");
	assert.ok(writes.at(-1) === ENABLE, "focus reporting enabled");

	// Input stripping: focus reports are consumed; plain input passes through.
	assert.deepEqual(input("\x1b[Iabc"), { data: "abc" });
	assert.deepEqual(input("\x1b["), { data: "" });
	assert.deepEqual(input("Iabc"), { data: "abc" }, "focus report is stripped across input chunks");
	assert.deepEqual(input("\x1b"), undefined, "a standalone Esc remains available to the TUI");
	assert.deepEqual(input("abc"), undefined);
	assert.deepEqual(input("\x1b[O"), { data: "" });
	input("\x1b[I"); // leave the mocked window focused for the checks below

	// 1004 authoritative: settle while focused → no marker, no BEL, no probe.
	setProbe("away"); // the probe must not even matter when 1004 is authoritative
	settle();
	assert.equal(lastTitle, undefined);

	// 1004 authoritative: settle while away → ● prefix and one BEL.
	input("\x1b[O");
	now += 60_000;
	settle();
	assert.equal(lastTitle, `● ${BASE}`);
	assert.ok(writes.at(-1) === "\x07", "BEL rides along with the marker");

	// Focus-in clears the marker and restores the exact base title.
	input("\x1b[I");
	assert.equal(lastTitle, BASE);

	// Errored settle while away → ❌; aborted settle → nothing.
	input("\x1b[O");
	now += 60_000;
	settle("error");
	assert.equal(lastTitle, `❌ ${BASE}`);
	input("\x1b[I");
	input("\x1b[O");
	now += 60_000;
	fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	fire("agent_settled", { type: "agent_settled", aborted: true });
	assert.equal(lastTitle, BASE, "aborted settle leaves the title alone");

	// before_agent_start clears a shown marker (user submitted → present).
	input("\x1b[O");
	now += 60_000;
	settle();
	assert.equal(lastTitle, `● ${BASE}`);
	fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "next" });
	assert.equal(lastTitle, BASE);

	// Probe decides when no 1004 report exists.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	now += 60_000;
	setProbe("away");
	settle();
	assert.equal(lastTitle, `● ${BASE}`, "probe=away marks");

	// probe=present is the always-dot fix: user is watching the tab without
	// typing → no marker.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	now += 60_000;
	setProbe("present");
	const belsBefore = writes.filter((w) => w === "\x07").length;
	settle();
	assert.equal(lastTitle, undefined, "probe=present suppresses the marker");
	assert.equal(
		writes.filter((w) => w === "\x07").length,
		belsBefore,
		"no BEL when present",
	);

	// Probe failure falls back to the keypress heuristic.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	now += 60_000;
	setProbe("unknown");
	settle();
	assert.equal(lastTitle, `● ${BASE}`, "unknown probe + stale input marks");

	// Very recent input (≤3s) skips the probe entirely: the user just typed.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	now += 2_000;
	setProbe("away");
	settle();
	assert.equal(lastTitle, undefined, "input younger than 3s suppresses the marker");

	// Typing clears a shown marker and keeps it clear for the next settle.
	now += 60_000;
	settle();
	assert.equal(lastTitle, `● ${BASE}`);
	now += 1;
	input("x");
	assert.equal(lastTitle, BASE);
	now += 100;
	setProbe("away");
	settle();
	assert.equal(lastTitle, BASE, "recent input still suppresses the marker");

	// No input ever (resumed session): the probe decides.
	boot();
	fire("session_start", { type: "session_start", reason: "resume" });
	now += 60_000;
	setProbe("away");
	settle();
	assert.equal(lastTitle, `● ${BASE}`, "no input plus probe=away marks");
	boot();
	fire("session_start", { type: "session_start", reason: "resume" });
	now += 60_000;
	setProbe("present");
	settle();
	assert.equal(lastTitle, undefined, "no input plus probe=present stays clean");

	// Errored finish is ❌ regardless of compaction; compaction itself never
	// touches the title, and only compactions during the run count.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	fire("session_compact", {
		type: "session_compact",
		compactionEntry: {},
		fromExtension: false,
		reason: "threshold",
	});
	assert.equal(lastTitle, undefined, "compaction by itself shows nothing");
	now += 60_000;
	setProbe("away");
	settle();
	assert.equal(lastTitle, `✅ ${BASE}`, "normal finish after a compacted run marks ✅");
	// Errored finish after compaction still marks ❌.
	input("x");
	assert.equal(lastTitle, BASE);
	now += 60_000;
	fire("session_compact", {
		type: "session_compact",
		compactionEntry: {},
		fromExtension: false,
		reason: "overflow",
	});
	settle("error");
	assert.equal(lastTitle, `❌ ${BASE}`, "errored finish marks ❌ even after compaction");
	// A manual /compact between turns does not swap the next done glyph.
	input("x");
	assert.equal(lastTitle, BASE);
	now += 60_000;
	fire("session_compact", {
		type: "session_compact",
		compactionEntry: {},
		fromExtension: false,
		reason: "manual",
	});
	fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "next" });
	now += 60_000;
	settle();
	assert.equal(lastTitle, `● ${BASE}`, "manual compaction between turns does not count");
	// Failed compaction has no handler at all (its fallout surfaces as an
	// errored turn → ❌).
	assert.ok(!handlers?.has("session_compact_failed"), "no handler for failed compaction");

	// Blocking UI prompts: 🔐 for confirmations (authorization), ❓ for other
	// kinds; same away-only gate; ui_prompt_end drops only the waiting marker.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	now += 60_000;
	setProbe("away");
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
	assert.equal(lastTitle, `🔐 ${BASE}`, "confirm prompt marks 🔐 while away");
	fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt" });
	assert.equal(lastTitle, BASE, "prompt end drops the waiting marker");
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "input" });
	assert.equal(lastTitle, `❓ ${BASE}`, "input prompt marks ❓ while away");
	input("y");
	assert.equal(lastTitle, BASE);
	// A prompt right after typing shows nothing (the user is here).
	now += 100;
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
	assert.equal(lastTitle, BASE, "fresh input suppresses the waiting marker");

	// A prompt can close without terminal input (for example by timeout).
	// Its delayed presence answer must neither mark nor ring after it closes.
	for (const kind of ["confirm", "input"]) {
		boot();
		fire("session_start", { type: "session_start", reason: "startup" });
		setProbe("away");
		process.env.PI_NOTIFY_DOT_PROBE_ASYNC = "1";
		const belsBeforePrompt = writes.filter((w) => w === "\x07").length;
		fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind });
		fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(lastTitle, undefined, `closed ${kind} prompt discards its delayed marker`);
		assert.equal(writes.filter((w) => w === "\x07").length, belsBeforePrompt, "closed prompt emits no BEL");
		settle();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(lastTitle, `● ${BASE}`, "completion still marks after the prompt closes");
		delete process.env.PI_NOTIFY_DOT_PROBE_ASYNC;
	}

	// Closing one prompt must not discard an unrelated completion probe.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	setProbe("away");
	process.env.PI_NOTIFY_DOT_PROBE_ASYNC = "1";
	settle();
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
	fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lastTitle, `● ${BASE}`, "prompt end preserves an already pending completion");
	delete process.env.PI_NOTIFY_DOT_PROBE_ASYNC;

	// A new question must not inherit the previous confirmation's stronger glyph.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	setProbe("away");
	process.env.PI_NOTIFY_DOT_PROBE_ASYNC = "1";
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
	fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "input" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lastTitle, `❓ ${BASE}`, "only the current prompt's marker can appear");
	delete process.env.PI_NOTIFY_DOT_PROBE_ASYNC;

	// Priority: a weaker unseen settle never overwrites a stronger marker.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	now += 60_000;
	setProbe("away");
	settle("error");
	assert.equal(lastTitle, `❌ ${BASE}`);
	settle(); // background re-settle without a submit in between
	assert.equal(lastTitle, `❌ ${BASE}`, "unseen ❌ survives a milder ● settle");
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
	assert.equal(lastTitle, `❌ ${BASE}`, "unseen ❌ also outranks 🔐");
	input("x");
	assert.equal(lastTitle, BASE);
	now += 60_000;
	settle();
	assert.equal(lastTitle, `● ${BASE}`);
	fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
	assert.equal(lastTitle, `🔐 ${BASE}`, "waiting 🔐 upgrades an unseen ●");

	// Generation guard: a probe that resolves after user interaction is
	// discarded — no stale marker or surprise BEL in the user's face.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	now = 1_000;
	input("hello");
	setProbe("away");
	process.env.PI_NOTIFY_DOT_PROBE_ASYNC = "1";
	now += 60_000;
	settle(); // schedules the probe answer on the next tick
	input("x"); // the user returns before the answer arrives
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lastTitle, undefined, "stale probe answer is discarded (title never touched)");
	// Positive control: uncontested, the async probe still marks.
	now += 60_000;
	settle();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lastTitle, `● ${BASE}`, "async probe applies when uncontested");

	// Session/run resets and shutdown invalidate pending notifications too.
	for (const boundary of ["session_start", "before_agent_start", "session_shutdown"]) {
		boot();
		fire("session_start", { type: "session_start", reason: "startup" });
		setProbe("away");
		process.env.PI_NOTIFY_DOT_PROBE_ASYNC = "1";
		const bells = writes.filter(w => w === "\x07").length;
		settle();
		fire(boundary, { type: boundary, reason: "reload" });
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(lastTitle, undefined, `${boundary} rejects an older completion`);
		assert.equal(writes.filter(w => w === "\x07").length, bells, `${boundary} prevents a late BEL`);
		delete process.env.PI_NOTIFY_DOT_PROBE_ASYNC;
	}

	// Clearing reads the current session name instead of a captured base title.
	boot();
	const renamedCtx = makeCtx();
	let sessionName = "s1";
	renamedCtx.sessionManager.getSessionName = () => sessionName;
	fire("session_start", { type: "session_start", reason: "startup" }, renamedCtx);
	input("\x1b[O");
	fire("agent_settled", { type: "agent_settled", aborted: false }, renamedCtx);
	assert.equal(lastTitle, `● ${BASE}`);
	sessionName = "renamed";
	input("\x1b[I");
	assert.equal(lastTitle, "π - renamed - proj", "focus-in restores the live session title");

	// Shutdown restores the terminal: marker cleared, 1004 dropped, unhooked.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" });
	input("\x1b[O");
	now += 60_000;
	settle();
	assert.equal(lastTitle, `● ${BASE}`);
	fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(lastTitle, BASE);
	assert.ok(inputUnsubbed, "input hook removed");
	assert.ok(writes.at(-1) === DISABLE, "focus reporting disabled");

	// Non-TUI modes never hook, write sequences, or touch the title.
	boot();
	fire("session_start", { type: "session_start", reason: "startup" }, makeCtx("print"));
	assert.equal(inputHandler, undefined);
	const writesBefore = writes.length;
	fire("agent_settled", { type: "agent_settled", aborted: false }, makeCtx("print"));
	assert.equal(writes.length, writesBefore, "print mode writes nothing");
	assert.equal(lastTitle, undefined);

		originalWrite("notify-dot: all assertions passed\n");
	} finally {
		handlers?.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, makeCtx());
		Date.now = originalNow;
		process.stdout.write = originalWrite;
		delete process.env.PI_NOTIFY_DOT;
		setProbe(undefined);
		delete process.env.PI_NOTIFY_DOT_PROBE_ASYNC;
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
