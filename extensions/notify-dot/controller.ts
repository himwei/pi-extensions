import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FocusPresence, FocusSource } from "./focus-input.js";
import { createPresenceProbe } from "./presence-probe.js";

const MARKERS = {
	done: { glyph: "●", rank: 0 },
	compacted: { glyph: "✅", rank: 1 },
	ask: { glyph: "❓", rank: 2 },
	auth: { glyph: "🔐", rank: 3 },
	error: { glyph: "❌", rank: 4 },
} as const;
type Marker = keyof typeof MARKERS;
type Presence = FocusPresence | "unknown";
interface Effects {
	write(data: string): void;
	debug(message: string): void;
	note(event: string, details?: Record<string, unknown>): void;
}

/** Read current names each time: a rename must not leave a cached title/suffix. */
function sessionIdentity(ctx: ExtensionContext) {
	const cwd = ctx.sessionManager.getCwd();
	const cwdBase = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
	const name = ctx.sessionManager.getSessionName();
	const suffix = name ? ` - ${name} - ${cwdBase}` : ` - ${cwdBase}`;
	return {
		key: `${ctx.sessionManager.getSessionId()}\0${cwd}\0${name ?? ""}`,
		title: `π${suffix}`, suffix,
	};
}

/** Notification intent and state. Input subscriptions and diagnostics own their resources separately. */
export function createNotificationController(effects: Effects) {
	let presence: Presence = "unknown";
	let focusReported = false;
	let lastInputAt: number | undefined;
	let activeMarker: Marker | undefined;
	let compacted = false;
	let lastTurnErrored = false;
	let lastCtx: ExtensionContext | undefined;
	let sessionKey: string | undefined;
	// Request freshness is distinct from the probe's subprocess/cache generation.
	let generation = 0;
	// Ending a prompt expires only that prompt, not independent completion work.
	let promptGeneration = 0;
	const foregroundProbe = createPresenceProbe(effects.debug);

	function invalidatePending(): void {
		generation++;
		foregroundProbe.invalidate();
	}

	function setContext(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const key = sessionIdentity(ctx).key;
		if (sessionKey !== undefined && sessionKey !== key) invalidatePending();
		sessionKey = key;
		lastCtx = ctx;
	}

	function applyMarker(marker: Marker): void {
		if (!lastCtx || activeMarker === marker) return;
		if (activeMarker !== undefined && MARKERS[marker].rank <= MARKERS[activeMarker].rank) return;
		activeMarker = marker;
		const glyph = MARKERS[marker].glyph;
		effects.note("marker_applied", { marker: glyph });
		effects.debug(`applyMarker ${glyph}`);
		lastCtx.ui.setTitle(`${glyph} ${sessionIdentity(lastCtx).title}`);
		effects.write("\x07");
	}

	function clearMarker(): void {
		if (!lastCtx || activeMarker === undefined) return;
		effects.note("marker_cleared", { marker: MARKERS[activeMarker].glyph });
		activeMarker = undefined;
		lastCtx.ui.setTitle(sessionIdentity(lastCtx).title);
	}

	/** Acknowledging attention also rejects any older asynchronous request. */
	function acknowledge(): void {
		invalidatePending();
		clearMarker();
	}

	function focusChanged(next: FocusPresence, source: FocusSource): void {
		effects.note("focus_observed", { source, presence: next });
		const changed = !focusReported || presence !== next;
		focusReported = true;
		presence = next;
		if (changed) {
			if (next === "present") acknowledge();
			else invalidatePending();
		} else if (next === "present") {
			clearMarker();
		}
	}

	function userActivity(at: number): void {
		presence = "present";
		lastInputAt = at;
		acknowledge();
	}

	function requestMarker(marker: Marker, isCurrent: () => boolean = () => true): void {
		if (focusReported) {
			if (presence === "away") applyMarker(marker);
			else clearMarker();
			return;
		}
		if (lastInputAt !== undefined && Date.now() - lastInputAt <= 3_000) {
			clearMarker();
			return;
		}
		const gen = generation;
		foregroundProbe.probe(lastCtx ? sessionIdentity(lastCtx).suffix : "", result => {
			if (gen !== generation || !isCurrent()) return;
			if (result === "away") { applyMarker(marker); return; }
			if (result === "present") { clearMarker(); return; }
			if (lastInputAt !== undefined && Date.now() - lastInputAt > 8_000) applyMarker(marker);
			else clearMarker();
		});
	}

	function resetSession(): void {
		// Presence belongs to the terminal lifecycle and survives session changes.
		invalidatePending();
		clearMarker();
	}

	function resetRun(): void {
		clearMarker();
		invalidatePending();
		lastTurnErrored = false;
		compacted = false;
	}

	function settle(aborted: boolean): void {
		if (aborted) { compacted = false; return; }
		const marker = lastTurnErrored ? "error" : compacted ? "compacted" : "done";
		compacted = false;
		effects.debug(`settled marker=${MARKERS[marker].glyph} focusReported=${focusReported} lastInputAge=${
			lastInputAt === undefined ? "n/a" : `${Date.now() - lastInputAt}ms`
		}`);
		requestMarker(marker);
	}

	function startPrompt(kind: string): void {
		const prompt = ++promptGeneration;
		requestMarker(kind === "confirm" ? "auth" : "ask", () => prompt === promptGeneration);
	}

	function endPrompt(): void {
		promptGeneration++;
		if (activeMarker === "auth" || activeMarker === "ask") clearMarker();
	}

	function dispose(ctx: ExtensionContext): void {
		generation++;
		foregroundProbe.dispose();
		if (ctx.mode === "tui") {
			lastCtx = ctx;
			clearMarker();
		}
		sessionKey = undefined;
		presence = "unknown";
		focusReported = false;
		lastInputAt = undefined;
		activeMarker = undefined;
		compacted = false;
		lastTurnErrored = false;
	}

	return {
		setContext, focusChanged, userActivity, invalidatePending,
		acknowledge, resetSession, resetRun, settle, startPrompt, endPrompt, dispose,
		recordOutcome(errored: boolean) { lastTurnErrored = errored; },
		recordCompaction() { compacted = true; },
		notifyDone(isCurrent: () => boolean) { requestMarker("done", isCurrent); },
		getState() { return { presence, focusReported, marker: activeMarker === undefined ? null : MARKERS[activeMarker].glyph }; },
	};
}
