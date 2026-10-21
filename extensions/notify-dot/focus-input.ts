import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type FocusPresence = "present" | "away";
export type FocusSource = "stdin" | "extension";
export const FOCUS_REPORT_ENABLE = "\x1b[?1004h";
const FOCUS_REPORT_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

interface InputEvents {
	focusChanged(presence: FocusPresence, source: FocusSource): void;
	userActivity(at: number): void;
	pendingInput(): void;
	extensionInput(data: string): void;
	write(data: string): void;
	debug(message: string): void;
}

/** Observe only DECSET 1004 reports before fullscreen TUI listeners consume them. */
export function observeTerminalFocus(onFocus: (presence: FocusPresence) => void): () => void {
	let tail = "";
	const onData = (chunk: string | Buffer) => {
		const data = tail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		for (const match of data.matchAll(/\x1b\[([IO])/g)) {
			onFocus(match[1] === "I" ? "present" : "away");
		}
		// Retain only a possible unfinished focus prefix, including a split Esc.
		tail = data.endsWith("\x1b[") ? "\x1b[" : data.endsWith("\x1b") ? "\x1b" : "";
	};
	process.stdin.prependListener("data", onData);
	return () => {
		process.stdin.off("data", onData);
		tail = "";
	};
}

/** Adapt terminal protocol to focus/activity callbacks, retaining independent stream state. */
export function createTerminalInput(events: InputEvents) {
	let inputUi: ExtensionContext["ui"] | undefined;
	let unsubInput: (() => void) | undefined;
	let unsubFocus: (() => void) | undefined;
	let focusModeEnabled = false;
	let focusSequenceTail = "";

	function handleInput(data: string): { data: string } | undefined {
		events.extensionInput(data);
		let sawIn = false;
		let sawOut = false;
		let lastFocus: FocusPresence | undefined;
		let changed = focusSequenceTail !== "";
		const combined = focusSequenceTail + data;
		focusSequenceTail = "";
		let rest = "";
		for (let i = 0; i < combined.length;) {
			const remaining = combined.slice(i);
			if (remaining.startsWith(FOCUS_IN)) {
				sawIn = true;
				lastFocus = "present";
				changed = true;
				i += FOCUS_IN.length;
				continue;
			}
			if (remaining.startsWith(FOCUS_OUT)) {
				sawOut = true;
				lastFocus = "away";
				changed = true;
				i += FOCUS_OUT.length;
				continue;
			}
			// Extension input must pass a standalone Esc through immediately.
			// Only the read-only observer can retain that one-byte prefix safely.
			if (remaining.length >= 2 && remaining.length < FOCUS_IN.length &&
				(FOCUS_IN.startsWith(remaining) || FOCUS_OUT.startsWith(remaining))) {
				focusSequenceTail = remaining;
				changed = true;
				break;
			}
			rest += combined.charAt(i++);
		}
		if (lastFocus !== undefined) events.focusChanged(lastFocus, "extension");
		if (rest.length > 0) events.userActivity(Date.now());
		else if (focusSequenceTail !== "") events.pendingInput();
		const preview = data.length > 120 ? `${data.slice(0, 120)}…` : data;
		events.debug(`input ${JSON.stringify(preview.replace(/\x1b/g, "ESC"))} → sawIn=${sawIn} sawOut=${sawOut} activity=${rest.length > 0}`);
		return changed ? { data: rest } : undefined;
	}

	function bind(ui: ExtensionContext["ui"]): void {
		if (!unsubFocus) unsubFocus = observeTerminalFocus(next => events.focusChanged(next, "stdin"));
		if (inputUi !== ui) {
			unsubInput?.();
			unsubInput = undefined;
			const off = ui.onTerminalInput(handleInput);
			inputUi = ui;
			if (typeof off === "function") unsubInput = off;
			events.debug("hooked extension input");
		}
		if (!focusModeEnabled) {
			events.debug("enabling 1004 focus reporting");
			events.write(FOCUS_REPORT_ENABLE);
			focusModeEnabled = true;
		}
	}

	function dispose(): void {
		unsubInput?.();
		unsubInput = undefined;
		unsubFocus?.();
		unsubFocus = undefined;
		inputUi = undefined;
		if (focusModeEnabled) events.write(FOCUS_REPORT_DISABLE);
		focusModeEnabled = false;
		focusSequenceTail = "";
	}

	return { bind, dispose };
}
