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
 * ~/.pi/agent/notify-dot-debug.log. `PI_NOTIFY_DOT_PROBE=present|away|unknown`
 * simulates the probe for tests and debugging.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG = {
	/** Markers prefixed to the tab title. */
	markerDone: "●",
	/** Done glyph for a run that included a context compaction. */
	markerDoneCompacted: "✅",
	markerError: "❌",
	/** Emit BEL when a marker is applied. */
	bell: true,
	/** Typing this recently means "present"; the probe is skipped. */
	skipProbeIfInputYoungerMs: 3_000,
	/** Heuristic fallback window when the probe cannot answer. */
	presenceTimeoutMs: 8_000,
	/** Foreground-probe result cache lifetime. */
	probeCacheMs: 3_000,
	/** Hard kill for the probe child before reporting "unknown". */
	probeTimeoutMs: 4_000,
} as const;

const FOCUS_REPORT_ENABLE = "\x1b[?1004h";
const FOCUS_REPORT_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEL = "\x07";
/** Matches Pi's interactive title: APP_TITLE is "π" without a piConfigName. */
const APP_TITLE = "π";
const PROBE_SCRIPT = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"notify-dot",
	"foreground-check.ps1",
);
const PWSH_FALLBACK = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

type Presence = "present" | "away" | "unknown";
type ProbeResult = "present" | "away" | "unknown";

const DEBUG = process.env.PI_NOTIFY_DOT_DEBUG === "1";
const DEBUG_LOG = path.join(os.homedir(), ".pi", "agent", "notify-dot-debug.log");

function debug(msg: string): void {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// Diagnostics must never break the extension.
	}
}

const escapeSeq = (s: string): string => JSON.stringify(s.replace(/\x1b/g, "ESC"));

function pwshBin(): string {
	if (process.env.PI_POWERSHELL_EXE) return process.env.PI_POWERSHELL_EXE;
	if (process.platform === "win32" && fs.existsSync(PWSH_FALLBACK)) return PWSH_FALLBACK;
	return "pwsh";
}

function inWindowsTerminal(): boolean {
	// Same identification oh-my-pi uses: WT_SESSION plus an optional TERM_PROGRAM
	// cross-check. Avoids spawning the probe inside VSCode/conhost-style hosts.
	if (process.env.WT_SESSION) return true;
	return (process.env.TERM_PROGRAM ?? "").toLowerCase() === "windows_terminal";
}

function basename(p: string): string {
	const parts = p.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? p;
}

/** Rebuild Pi's own base title so clearing a marker restores exactly it. */
function baseTitle(ctx: ExtensionContext): string {
	const cwdBase = basename(ctx.cwd);
	const name = ctx.sessionManager.getSessionName();
	return name ? `${APP_TITLE} - ${name} - ${cwdBase}` : `${APP_TITLE} - ${cwdBase}`;
}

/**
 * Suffix used to recognise this session's WT tab, independent of the app
 * prefix: ` - <session> - <cwd>` when named, ` - <cwd>` otherwise.
 */
function baseSuffix(ctx: ExtensionContext): string {
	const cwdBase = basename(ctx.cwd);
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
	let hooked = false;
	let focusModeEnabled = false;
	let lastCtx: ExtensionContext | undefined;
	let unsubInput: (() => void) | undefined;
	let probeCache: { at: number; result: ProbeResult } | undefined;
	let pwshBroken = false;
	/** In-flight probe, killed on shutdown so it can never delay exit. */
	let probeChild: ReturnType<typeof spawn> | undefined;

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

	/**
	 * Ask the OS whether the foreground WT tab is this session. Async and
	 * cache-backed so back-to-back decisions share one spawn.
	 */
	function probeForeground(cb: (result: ProbeResult) => void): void {
		const sim = process.env.PI_NOTIFY_DOT_PROBE;
		if (sim === "present" || sim === "away" || sim === "unknown") {
			cb(sim);
			return;
		}
		if (process.platform !== "win32" || pwshBroken || !inWindowsTerminal()) {
			cb("unknown");
			return;
		}
		if (probeCache && Date.now() - probeCache.at <= CONFIG.probeCacheMs) {
			cb(probeCache.result);
			return;
		}
		let settled = false;
		const done = (result: ProbeResult): void => {
			if (settled) return;
			settled = true;
			probeCache = { at: Date.now(), result };
			debug(`probe ${result}`);
			cb(result);
		};
		try {
			const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PROBE_SCRIPT];
			if (lastCtx) args.push("-ExpectedSuffix", baseSuffix(lastCtx));
			const child = spawn(pwshBin(), args, {
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			probeChild = child;
			let out = "";
			const timer = setTimeout(() => {
				child.kill();
				done("unknown");
			}, CONFIG.probeTimeoutMs);
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString("utf8");
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				pwshBroken = true;
				debug(`probe spawn error: ${err.message}`);
				done("unknown");
			});
			child.on("close", () => {
				clearTimeout(timer);
				if (probeChild === child) probeChild = undefined;
				const v = out.trim();
				done(v === "present" || v === "away" ? v : "unknown");
			});
		} catch (err) {
			debug(`probe exception: ${err instanceof Error ? err.message : String(err)}`);
			done("unknown");
		}
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
		probeForeground((result) => {
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
	 * Strip focus reports from the raw stream so the TUI never parses them.
	 * Any surviving input proves the window is focused and clears the marker.
	 */
	function handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		let sawIn = false;
		let sawOut = false;
		if (data.includes(FOCUS_IN)) sawIn = true;
		if (data.includes(FOCUS_OUT)) sawOut = true;
		if (sawIn || sawOut) {
			focusReported = true;
			presence = sawIn && !sawOut ? "present" : sawOut && !sawIn ? "away" : presence;
		}
		const rest = data.split(FOCUS_IN).join("").split(FOCUS_OUT).join("");
		const hasInput = rest.length > 0;
		if (hasInput) {
			presence = "present";
			lastInputAt = Date.now();
		}
		if (presence === "present" && (sawIn || hasInput)) clearMarker();
		debug(
			`input ${escapeSeq(data.length > 120 ? `${data.slice(0, 120)}…` : data)} ` +
				`→ sawIn=${sawIn} sawOut=${sawOut} presence=${presence} focusReported=${focusReported}`,
		);
		return rest === data ? undefined : { data: rest };
	}

	/** Idempotent: hook raw input and enable focus reporting (TUI only). */
	function ensureHooked(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (!hooked) {
			hooked = true;
			lastCtx = ctx;
			const off = ctx.ui.onTerminalInput(handleTerminalInput);
			if (typeof off === "function") unsubInput = off;
			debug("hooked raw input, enabling 1004");
		}
		writeStdout(FOCUS_REPORT_ENABLE);
		focusModeEnabled = true;
	}

	pi.on("session_start", (_event, ctx) => {
		ensureHooked(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		ensureHooked(ctx);
		// A new run means the user just submitted here: present, marker stale.
		clearMarker();
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
	pi.on("session_compact", (event) => {
		// Never touches the title: it only swaps ● for ✅ at the next settle.
		compacted = true;
		debug(`compact reason=${event.reason} fromExtension=${event.fromExtension}`);
	});
	pi.on("session_shutdown", (event, ctx) => {
		debug(`shutdown reason=${event.reason}`);
		// Kill any in-flight probe first: a completion check must never delay
		// process exit (the unref lesson from oh-my-pi's desktop-notify).
		probeChild?.kill();
		probeChild = undefined;
		// Restore the terminal, then reset for the next runtime in this process.
		if (activeMarker !== undefined && ctx.mode === "tui") clearMarker();
		unsubInput?.();
		unsubInput = undefined;
		if (focusModeEnabled) writeStdout(FOCUS_REPORT_DISABLE);
		hooked = false;
		focusModeEnabled = false;
		focusReported = false;
		presence = "unknown";
		lastInputAt = undefined;
		activeMarker = undefined;
		compacted = false;
		lastTurnErrored = false;
		probeCache = undefined;
	});
}
