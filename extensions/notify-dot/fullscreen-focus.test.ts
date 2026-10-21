import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import notifyDot from "../notify-dot.js";

// Exercise the actual fullscreen input dispatcher without starting a renderer,
// changing console modes, or performing GUI interaction.
const ui = new TuiAltScreen({ columns: 100, rows: 30 } as Terminal);
const dispatch = (ui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput.bind(ui);
const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
const writes: string[] = [];
const originalWrite = process.stdout.write;
const previousProbe = process.env.PI_NOTIFY_DOT_PROBE;
const initialListeners = process.stdin.listenerCount("data");
let title: string | undefined;
let extensionFocusEvents = 0;
const ctx = {
	mode: "tui",
	sessionManager: {
		getCwd: () => "C:\\work\\proj", getSessionName: () => "fullscreen-test", getSessionId: () => "fullscreen-test",
	},
	ui: {
		setTitle: (value: string) => { title = value; },
		onTerminalInput: (listener: (data: string) => unknown) => ui.addInputListener(data => {
			if (data === "\x1b[I" || data === "\x1b[O") extensionFocusEvents++;
			return listener(data) as undefined;
		}),
	},
} as unknown as ExtensionContext;
const fire = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
const settle = () => {
	fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	fire("agent_settled", { aborted: false });
};

process.stdout.write = ((chunk: string | Uint8Array) => {
	writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
	return true;
}) as typeof process.stdout.write;
try {
	process.env.PI_NOTIFY_DOT_PROBE = "away";
	notifyDot({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerCommand() {},
	} as unknown as ExtensionAPI);
	fire("session_start");
	process.stdin.emit("data", "\x1b[O");
	dispatch("\x1b[O");
	settle();
	assert.equal(title, "● π - fullscreen-test - proj");

	// The actual Pi buffer reconstructs these chunks before dispatch, while
	// the raw observer must handle the split independently without consuming it.
	for (const chunk of ["\x1b", "[", "I"]) process.stdin.emit("data", chunk);
	dispatch("\x1b[I");
	assert.equal(extensionFocusEvents, 0, "Pi fullscreen consumes focus before extension listeners");
	assert.equal(title, "π - fullscreen-test - proj", "raw focus-in clears even when fullscreen consumes it");
	const bells = writes.filter(value => value === "\x07").length;
	settle();
	assert.equal(writes.filter(value => value === "\x07").length, bells, "observed focus suppresses an away probe result");

	fire("session_start");
	assert.equal(process.stdin.listenerCount("data"), initialListeners + 1, "session events do not duplicate raw observers");
	fire("session_shutdown", { reason: "quit" });
	assert.equal(process.stdin.listenerCount("data"), initialListeners, "shutdown removes raw observer");
	process.stdin.emit("data", "\x1b[O");
	assert.equal(title, "π - fullscreen-test - proj", "late focus after shutdown does not touch the title");
	originalWrite.call(process.stdout, "fullscreen-focus: all assertions passed\n");
} finally {
	fire("session_shutdown", { reason: "quit" });
	process.stdout.write = originalWrite;
	if (previousProbe === undefined) delete process.env.PI_NOTIFY_DOT_PROBE;
	else process.env.PI_NOTIFY_DOT_PROBE = previousProbe;
}
