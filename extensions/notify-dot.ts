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
 *   gate — and `ui_prompt_end` drops the waiting marker and expires only
 *   that prompt's pending answer, preserving unrelated completion probes.
 * - Unseen markers keep priority ❌ > 🔐 > ❓ > ✅ > ●: a later, weaker settle
 *   never overwrites a stronger one the user has not seen.
 * - Probe answers are generation-guarded: input, a new submit, or shutdown
 *   during an in-flight probe discards its result — no stale marker after
 *   the user returns.
 * - The event marker clears on any terminal input, on the next submitted
 *   prompt (`before_agent_start`), and on shutdown. A read-only stdin observer
 *   handles DECSET 1004 focus-in before Pi's fullscreen TUI consumes it, so
 *   returning also clears the marker without typing. The TUI still receives
 *   every byte; regular-mode extension input strips any surviving reports
 *   before the editor. /notifydiag observes the real input layers.
 *
 * Presence for the event marker, in precedence order:
 * 1. DECSET 1004 focus reports, when the terminal delivers them.
 * 2. Foreground probe: detached `pwsh` runs `notify-dot/foreground-check.ps1`,
 *    which decides tab-level on Windows Terminal (window caption, then UIA
 *    selected tab matched by title suffix, then a window-level ancestor check).
 *    Skipped when the user typed within the last 3 seconds.
 * 3. Probe failure → keypress heuristic (input older than 8 seconds).
 *
 * Kill switch: `PI_NOTIFY_DOT=off`. Debug log: `PI_NOTIFY_DOT_DEBUG=1` writes
 * notify-dot-debug.log under Pi's configured agent directory.
 * `PI_NOTIFY_DOT_PROBE=present|away|unknown`
 * simulates the probe for tests and debugging.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotificationController } from "./notify-dot/controller.js";
import { registerFocusDiagnostics } from "./notify-dot/focus-diagnostics.js";
import { createTerminalInput } from "./notify-dot/focus-input.js";

const DEBUG = process.env.PI_NOTIFY_DOT_DEBUG === "1";
const DEBUG_LOG = path.join(getAgentDir(), "notify-dot-debug.log");

function debug(message: string): void {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Diagnostics must never break the extension.
	}
}

function writeStdout(data: string): void {
	try {
		process.stdout.write(data);
		debug(`wrote ${JSON.stringify(data.replace(/\x1b/g, "ESC"))}`);
	} catch {
		// Best-effort only; never fail an event handler over a sequence.
	}
}

export default function notifyDot(pi: ExtensionAPI) {
	if (["off", "0", "false"].includes((process.env.PI_NOTIFY_DOT ?? "").toLowerCase())) return;

	const diagnostics = registerFocusDiagnostics(pi, {
		bindContext,
		state: () => ({ ...controller.getState() }),
		testMarker: isCurrent => controller.notifyDone(isCurrent),
	});
	const controller = createNotificationController({ write: writeStdout, debug, note: diagnostics.note });
	const input = createTerminalInput({
		focusChanged: controller.focusChanged,
		userActivity: controller.userActivity,
		pendingInput: controller.invalidatePending,
		extensionInput: diagnostics.extensionInput,
		write: writeStdout, debug,
	});

	function bindContext(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		controller.setContext(ctx);
		input.bind(ctx.ui);
	}

	pi.on("session_start", (_event, ctx) => {
		bindContext(ctx);
		controller.resetSession();
	});
	pi.on("before_agent_start", (_event, ctx) => {
		bindContext(ctx);
		controller.resetRun();
	});
	pi.on("agent_end", (event, ctx) => {
		bindContext(ctx);
		// Capture this turn's outcome before compaction prunes its messages.
		const last = [...event.messages].reverse().find(message => message.role === "assistant");
		controller.recordOutcome(last?.stopReason === "error");
	});
	pi.on("agent_settled", (event, ctx) => {
		bindContext(ctx);
		controller.settle(event.aborted);
	});
	pi.on("ui_prompt_start", (event, ctx) => {
		bindContext(ctx);
		controller.startPrompt(event.kind);
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		bindContext(ctx);
		controller.endPrompt();
	});
	pi.on("session_compact", event => {
		controller.recordCompaction();
		debug(`compact reason=${event.reason} fromExtension=${event.fromExtension}`);
	});
	pi.on("session_shutdown", (event, ctx) => {
		debug(`shutdown reason=${event.reason}`);
		diagnostics.dispose();
		controller.dispose(ctx);
		input.dispose();
	});
}
