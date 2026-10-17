/**
 * Task-completion marker on the terminal tab title (KISS).
 *
 * - `agent_settled` (not aborted): when the user is NOT looking at this tab,
 *   prefix the title with a single marker and ring the bell once — "●" when
 *   the settled turn finished normally, "✅" when it finished normally AND
 *   the run included a context compaction, "❌" when it errored (compacted or
 *   not). Looking at the tab shows nothing, ever.
 * - Compaction never shows on its own: it only swaps the done glyph at the
 *   next settle, and only compactions during the run count (a manual
 *   `/compact` between turns does not).
 * - Blocking UI prompts wait visibly: `ui_prompt_start` with kind "confirm"
 *   (an authorization) marks 🔐 while other kinds mark ❓ — same away-only
 *   gate — and `ui_prompt_end` drops the waiting marker.
 * - Unseen markers keep priority ❌ > 🔐 > ❓ > ✅ > ●: a later, weaker settle
 *   never overwrites a stronger one the user has not seen.
 * - Probe answers are generation-guarded: input, a new submit, or shutdown
 *   during an in-flight probe discards its result — no stale marker after
 *   the user returns.
 * - The event marker clears on any terminal input, on the next submitted
 *   prompt (`before_agent_start`), and on shutdown; if ported terminals ever
 *   deliver DECSET 1004 focus reports, focus-in also clears it (we enable and
 *   consume those sequences here, so the TUI never sees them). With no focus
 *   event channel on Windows Terminal, a user who returns and does nothing
 *   keeps it until the next input — the known, accepted trade-off.
 *
 * Presence for the event marker, in precedence order:
 * 1. DECSET 1004 focus reports, when the terminal delivers them.
 * 2. Foreground probe: detached `pwsh` runs `notify-dot/foreground-check.ps1`,
 *    which decides tab-level on Windows Terminal (window caption, then UIA
 *    selected tab matched by title suffix, then a window-level ancestor check).
 *    Skipped when the user typed within `skipProbeIfInputYoungerMs`.
 * 3. Probe failure → keypress heuristic (`presenceTimeoutMs` fallback).
 *
 * Kill switch: `PI_NOTIFY_DOT=off`. Debug log: `PI_NOTIFY_DOT_DEBUG=1` writes
 * notify-dot-debug.log under Pi's configured agent directory.
 * `PI_NOTIFY_DOT_PROBE=present|away|unknown`
 * simulates the probe for tests and debugging.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPresenceProbe, type ProbeResult } from "./notify-dot/presence-probe.js";

const CONFIG = {
	/** Markers prefixed to the tab title. */
	markerDone: "●",
	/** Done glyph for a run that included a context compaction. */
	markerDoneCompacted: "✅",
	markerError: "❌",
	/** Waiting glyphs for blocking UI prompts: authorization vs question. */
	markerAuth: "🔐",
	markerAsk: "❓",
	/** Emit BEL when a marker is applied. */
	bell: true,
	/** Typing this recently means "present"; the probe is skipped. */
	skipProbeIfInputYoungerMs: 3_000,
	/** Heuristic fallback window when the probe cannot answer. */
	presenceTimeoutMs: 8_000,
} as const;

/** Unseen-marker priority: a weaker settle never overwrites a stronger one. */
const RANK: Record<string, number> = {
	[CONFIG.markerError]: 4,
	[CONFIG.markerAuth]: 3,
	[CONFIG.markerAsk]: 2,
	[CONFIG.markerDoneCompacted]: 1,
	[CONFIG.markerDone]: 0,
};

const FOCUS_REPORT_ENABLE = "\x1b[?1004h";
const FOCUS_REPORT_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEL = "\x07";
/** Matches Pi's interactive title: APP_TITLE is "π" without a piConfigName. */
const APP_TITLE = "π";
const AGENT_DIR = getAgentDir();

type Presence = "present" | "away" | "unknown";

const DEBUG = process.env.PI_NOTIFY_DOT_DEBUG === "1";
const DEBUG_LOG = path.join(AGENT_DIR, "notify-dot-debug.log");

function debug(msg: string): void {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// Diagnostics must never break the extension.
	}
}

const escapeSeq = (s: string): string => JSON.stringify(s.replace(/\x1b/g, "ESC"));

function basename(p: string): string {
	const parts = p.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? p;
}

/** Rebuild Pi's own base title so clearing a marker restores exactly it. */
function baseTitle(ctx: ExtensionContext): string {
	const cwdBase = basename(ctx.sessionManager.getCwd());
	const name = ctx.sessionManager.getSessionName();
	return name ? `${APP_TITLE} - ${name} - ${cwdBase}` : `${APP_TITLE} - ${cwdBase}`;
}

/**
 * Suffix used to recognise this session's WT tab, independent of the app
 * prefix: ` - <session> - <cwd>` when named, ` - <cwd>` otherwise.
 */
function baseSuffix(ctx: ExtensionContext): string {
	const cwdBase = basename(ctx.sessionManager.getCwd());
	const name = ctx.sessionManager.getSessionName();
	return name ? ` - ${name} - ${cwdBase}` : ` - ${cwdBase}`;
}

export default function notifyDot(pi: ExtensionAPI) {
	if (["off", "0", "false"].includes((process.env.PI_NOTIFY_DOT ?? "").toLowerCase())) return;

	let presence: Presence = "unknown";
	/** Whether the terminal ever answered with a 1004 focus report. */
	let focusReported = false;
	let lastInputAt: number | undefined;
	let activeMarker: string | undefined;
	/** True when a session_compact fired during the current run. */
	let compacted = false;
	let lastTurnErrored = false;
	let focusModeEnabled = false;
	let lastCtx: ExtensionContext | undefined;
	let inputUi: ExtensionContext["ui"] | undefined;
	let unsubInput: (() => void) | undefined;
	let sessionKey: string | undefined;
	/** Bumped on interaction/submit/shutdown; older probe answers are discarded. */
	let generation = 0;
	const foregroundProbe = createPresenceProbe(debug);
	let focusSequenceTail = "";

	function invalidateProbe(): void {
		generation++;
		foregroundProbe.invalidate();
	}

	function writeStdout(data: string): void {
		try {
			process.stdout.write(data);
			debug(`wrote ${escapeSeq(data)}`);
		} catch {
			// Best-effort only; never fail an event handler over a sequence.
		}
	}

	function applyMarker(marker: string): void {
		if (!lastCtx || activeMarker === marker) return;
		if (activeMarker !== undefined && RANK[marker] <= RANK[activeMarker]) {
			return; // An unseen, stronger marker outranks this one.
		}
		activeMarker = marker;
		debug(`applyMarker ${marker}`);
		lastCtx.ui.setTitle(`${marker} ${baseTitle(lastCtx)}`);
		if (CONFIG.bell) writeStdout(BEL);
	}

	function clearMarker(): void {
		if (!lastCtx || activeMarker === undefined) return;
		activeMarker = undefined;
		lastCtx.ui.setTitle(baseTitle(lastCtx));
	}

	/** Ask the isolated probe service whether the foreground WT tab is this session. */
	function probeForeground(cb: (result: ProbeResult) => void): void {
		foregroundProbe.probe(lastCtx ? baseSuffix(lastCtx) : "", cb);
	}

	/** Decide whether the user is looking at this tab, then apply or clear. */
	function settleMarker(marker: string): void {
		if (focusReported) {
			if (presence === "away") applyMarker(marker);
			else clearMarker();
			return;
		}
		if (
			lastInputAt !== undefined &&
			Date.now() - lastInputAt <= CONFIG.skipProbeIfInputYoungerMs
		) {
			clearMarker(); // The user just typed here: definitely present.
			return;
		}
		const gen = generation;
		probeForeground((result) => {
			if (gen !== generation) return; // The world moved on mid-probe; discard.
			if (result === "away") {
				applyMarker(marker);
				return;
			}
			if (result === "present") {
				clearMarker();
				return;
			}
			// Probe unavailable: stale input is the only remaining signal.
			if (lastInputAt !== undefined && Date.now() - lastInputAt > CONFIG.presenceTimeoutMs) {
				applyMarker(marker);
			} else {
				clearMarker();
			}
		});
	}

	/**
	 * Strip focus reports from the raw stream so the TUI never parses them,
	 * including sequences split across input chunks.
	 * Any surviving input proves the window is focused and clears the marker.
	 */
	function handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		let sawIn = false;
		let sawOut = false;
		let lastFocus: Presence | undefined;
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
			if (
				(remaining.length >= 2 && remaining.length < FOCUS_IN.length && FOCUS_IN.startsWith(remaining)) ||
				(remaining.length >= 2 && remaining.length < FOCUS_OUT.length && FOCUS_OUT.startsWith(remaining))
			) {
				focusSequenceTail = remaining;
				changed = true;
				break;
			}
			rest += combined.charAt(i);
			i++;
		}
		if (lastFocus !== undefined) {
			focusReported = true;
			presence = lastFocus;
		}
		const hasInput = rest.length > 0;
		if (hasInput) {
			presence = "present";
			lastInputAt = Date.now();
		}
		if (sawIn || sawOut || hasInput || focusSequenceTail !== "") invalidateProbe();
		if (presence === "present" && (sawIn || hasInput)) clearMarker();
		debug(
			`input ${escapeSeq(data.length > 120 ? `${data.slice(0, 120)}…` : data)} ` +
				`→ sawIn=${sawIn} sawOut=${sawOut} presence=${presence} focusReported=${focusReported}`,
		);
		return changed ? { data: rest } : undefined;
	}

	/** Idempotent: hook raw input and enable focus reporting (TUI only). */
	function ensureHooked(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const key = `${ctx.sessionManager.getSessionId()}\0${ctx.sessionManager.getCwd()}\0${ctx.sessionManager.getSessionName() ?? ""}`;
		if (sessionKey !== undefined && sessionKey !== key) invalidateProbe();
		sessionKey = key;
		lastCtx = ctx;
		if (inputUi !== ctx.ui) {
			unsubInput?.();
			unsubInput = undefined;
			const off = ctx.ui.onTerminalInput(handleTerminalInput);
			inputUi = ctx.ui;
			if (typeof off === "function") unsubInput = off;
			debug("hooked raw input");
		}
		if (!focusModeEnabled) {
			debug("enabling 1004 focus reporting");
			writeStdout(FOCUS_REPORT_ENABLE);
			focusModeEnabled = true;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ensureHooked(ctx);
		invalidateProbe();
		clearMarker();
	});
	pi.on("before_agent_start", (_event, ctx) => {
		ensureHooked(ctx);
		// A new run means the user just submitted here: present, marker stale.
		clearMarker();
		invalidateProbe(); // A new run invalidates in-flight and cached answers.
		lastTurnErrored = false;
		// Only compactions during the run swap its done glyph; a manual
		// /compact between turns must not.
		compacted = false;
	});
	pi.on("agent_end", (event, ctx) => {
		ensureHooked(ctx);
		// Read the settled turn's own outcome before compaction prunes it.
		const last = [...event.messages].reverse().find((m) => m.role === "assistant");
		lastTurnErrored = last?.stopReason === "error";
	});
	pi.on("agent_settled", (event, ctx) => {
		ensureHooked(ctx);
		if (event.aborted) {
			// Interrupted: the user is here; nothing carries over.
			compacted = false;
			return;
		}
		const marker = lastTurnErrored
			? CONFIG.markerError
			: compacted
				? CONFIG.markerDoneCompacted
				: CONFIG.markerDone;
		compacted = false; // Consume: the next turn starts fresh.
		debug(`settled marker=${marker} focusReported=${focusReported} lastInputAge=${
			lastInputAt === undefined ? "n/a" : `${Date.now() - lastInputAt}ms`
		}`);
		settleMarker(marker);
	});
	pi.on("ui_prompt_start", (event, ctx) => {
		ensureHooked(ctx);
		// The run is blocked on the user — a stronger attention need than
		// completion, and agent_settled never fires for it.
		const marker = event.kind === "confirm" ? CONFIG.markerAuth : CONFIG.markerAsk;
		settleMarker(marker);
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		ensureHooked(ctx);
		// Drop only a waiting marker; an unseen ❌/✅/● must survive.
		if (activeMarker === CONFIG.markerAuth || activeMarker === CONFIG.markerAsk) clearMarker();
	});
	pi.on("session_compact", (event) => {
		// Never touches the title: it only swaps ● for ✅ at the next settle.
		compacted = true;
		debug(`compact reason=${event.reason} fromExtension=${event.fromExtension}`);
	});
	pi.on("session_shutdown", (event, ctx) => {
		debug(`shutdown reason=${event.reason}`);
		// Kill in-flight probe work before clearing the session state.
		generation++;
		foregroundProbe.dispose();
		if (ctx.mode === "tui") lastCtx = ctx;
		// Restore the terminal, then reset for the next runtime in this process.
		if (activeMarker !== undefined && ctx.mode === "tui") clearMarker();
		unsubInput?.();
		unsubInput = undefined;
		inputUi = undefined;
		if (focusModeEnabled) writeStdout(FOCUS_REPORT_DISABLE);
		focusModeEnabled = false;
		sessionKey = undefined;
		focusReported = false;
		presence = "unknown";
		lastInputAt = undefined;
		activeMarker = undefined;
		compacted = false;
		lastTurnErrored = false;
		focusSequenceTail = "";
	});
}
