import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export type ProbeResult = "present" | "away" | "unknown";

const PROBE_SCRIPT = fileURLToPath(new URL("./foreground-check.ps1", import.meta.url));
const PWSH_FALLBACK = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const CACHE_MS = 3_000;
const TIMEOUT_MS = 4_000;

interface CachedProbe {
	at: number;
	key: string;
	result: ProbeResult;
}

interface PendingProbe {
	generation: number;
	key: string;
	callbacks: Array<(result: ProbeResult) => void>;
	child?: ReturnType<typeof spawn>;
	timer?: ReturnType<typeof setTimeout>;
	settled: boolean;
}

function pwshBin(): string {
	if (process.env.PI_POWERSHELL_EXE) return process.env.PI_POWERSHELL_EXE;
	if (process.platform === "win32" && fs.existsSync(PWSH_FALLBACK)) return PWSH_FALLBACK;
	return "pwsh";
}

function inWindowsTerminal(): boolean {
	if (process.env.WT_SESSION) return true;
	return (process.env.TERM_PROGRAM ?? "").toLowerCase() === "windows_terminal";
}

/** Owns probe caching, request deduplication, child cleanup, and stale-result rejection. */
export function createPresenceProbe(debug: (message: string) => void) {
	let generation = 0;
	let cache: CachedProbe | undefined;
	let pwshBroken = false;
	const pending = new Map<string, PendingProbe>();

	function finish(request: PendingProbe, result: ProbeResult): void {
		if (request.settled) return;
		request.settled = true;
		if (request.timer) clearTimeout(request.timer);
		if (pending.get(request.key) === request) pending.delete(request.key);
		if (request.generation !== generation) return;

		cache = { at: Date.now(), key: request.key, result };
		debug(`probe ${result}`);
		for (const callback of request.callbacks) callback(result);
	}

	function invalidate(): void {
		generation++;
		cache = undefined;
		for (const request of pending.values()) {
			request.settled = true;
			if (request.timer) clearTimeout(request.timer);
			request.child?.kill();
		}
		pending.clear();
	}

	function probe(expectedSuffix: string, callback: (result: ProbeResult) => void): void {
		const token = generation;
		const simulated = process.env.PI_NOTIFY_DOT_PROBE;
		if (simulated === "present" || simulated === "away" || simulated === "unknown") {
			const answer = () => {
				if (token === generation) callback(simulated);
			};
			// Test hook: let callers exercise invalidation before an answer arrives.
			if (process.env.PI_NOTIFY_DOT_PROBE_ASYNC === "1") setTimeout(answer, 0);
			else answer();
			return;
		}
		if (process.platform !== "win32" || pwshBroken || !inWindowsTerminal()) {
			callback("unknown");
			return;
		}

		const key = `${token}\0${expectedSuffix}`;
		if (cache?.key === key && Date.now() - cache.at <= CACHE_MS) {
			callback(cache.result);
			return;
		}
		const existing = pending.get(key);
		if (existing) {
			existing.callbacks.push(callback);
			return;
		}

		const request: PendingProbe = { generation: token, key, callbacks: [callback], settled: false };
		pending.set(key, request);
		try {
			const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PROBE_SCRIPT];
			if (expectedSuffix) args.push("-ExpectedSuffix", expectedSuffix);
			const child = spawn(pwshBin(), args, {
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			request.child = child;
			let output = "";
			request.timer = setTimeout(() => {
				child.kill();
				finish(request, "unknown");
			}, TIMEOUT_MS);
			child.stdout?.on("data", (chunk) => {
				if (output.length < 64) output += chunk.toString("utf8").slice(0, 64 - output.length);
			});
			child.on("error", (error) => {
				pwshBroken = true;
				debug(`probe spawn error: ${error.message}`);
				finish(request, "unknown");
			});
			child.on("close", () => {
				const value = output.trim();
				finish(request, value === "present" || value === "away" ? value : "unknown");
			});
		} catch (error) {
			debug(`probe exception: ${error instanceof Error ? error.message : String(error)}`);
			finish(request, "unknown");
		}
	}

	return { probe, invalidate, dispose: invalidate };
}
