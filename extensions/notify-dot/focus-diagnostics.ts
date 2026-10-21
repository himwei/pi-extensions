import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, matchesKey, truncateToWidth, type Terminal } from "@earendil-works/pi-tui";
import { FOCUS_REPORT_ENABLE } from "./focus-input.js";

type Stage = "raw" | "buffer" | "extension";
interface Counts { chunks: number; focusIn: number; focusOut: number }
const STAGES: Stage[] = ["raw", "buffer", "extension"];
const LOG_LIMIT = 1024 * 1024;

/** Observes input without recording typed text, changing console modes, or consuming bytes. */
export class FocusTrace {
	readonly counts: Record<Stage, Counts> = {
		raw: { chunks: 0, focusIn: 0, focusOut: 0 },
		buffer: { chunks: 0, focusIn: 0, focusOut: 0 },
		extension: { chunks: 0, focusIn: 0, focusOut: 0 },
	};
	readonly logPath: string;
	bufferAttached = false;
	logError: string | undefined;
	onChange: (() => void) | undefined;
	private readonly tails: Record<Stage, string> = { raw: "", buffer: "", extension: "" };
	private readonly cleanup: Array<() => void> = [];
	private fd: number | undefined;
	private bytes = 0;
	private disposed = false;
	private attached = false;

	constructor(logPath = path.join(getAgentDir(), `notify-dot-focus-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}.jsonl`)) {
		this.logPath = logPath;
		this.fd = fs.openSync(logPath, "wx");
		this.note("start", {
			node: process.version, execPath: process.execPath, libuv: process.versions.uv,
			stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY,
			windowsTerminal: !!process.env.WT_SESSION,
		});
	}

	note(event: string, details: Record<string, unknown> = {}): void {
		if (this.disposed || this.fd === undefined) return;
		const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\n";
		const size = Buffer.byteLength(line, "utf8");
		if (this.bytes + size > LOG_LIMIT) {
			this.logError = "日志已达 1 MiB 上限；屏幕计数继续，文件停止追加";
			return;
		}
		try {
			fs.writeSync(this.fd, line, undefined, "utf8");
			this.bytes += size;
		} catch (error) {
			this.logError = error instanceof Error ? error.message : String(error);
		}
	}

	record(stage: Stage, data: string): void {
		if (this.disposed) return;
		const counts = this.counts[stage];
		counts.chunks++;
		const combined = this.tails[stage] + data;
		const focus: string[] = [];
		for (const match of combined.matchAll(/\x1b\[([IO])/g)) {
			if (match[1] === "I") { counts.focusIn++; focus.push("in"); }
			else { counts.focusOut++; focus.push("out"); }
		}
		this.tails[stage] = combined.slice(-2);
		this.note("input", { stage, chars: data.length, focus });
		this.onChange?.();
	}

	attach(terminal: Terminal, stdin = process.stdin): void {
		if (this.disposed || this.attached) return;
		this.attached = true;
		const onRaw = (chunk: string | Buffer) => this.record("raw", typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		stdin.prependListener("data", onRaw);
		this.cleanup.push(() => stdin.off("data", onRaw));
		// Pi exposes the terminal through the public custom-UI API. Its buffer is
		// an internal detail: inspect it only for this explicitly opened diagnostic.
		// Attach to the existing emitter, never a shadow parser or a replacement.
		const buffer = (terminal as unknown as { stdinBuffer?: EventEmitter }).stdinBuffer;
		if (buffer && typeof buffer.prependListener === "function" && typeof buffer.off === "function") {
			const onBuffer = (sequence: string) => this.record("buffer", sequence);
			buffer.prependListener("data", onBuffer);
			this.cleanup.push(() => buffer.off("data", onBuffer));
			this.bufferAttached = true;
		}
		this.note("attached", { bufferAttached: this.bufferAttached, terminal: terminal.constructor.name });
	}

	dispose(): void {
		if (this.disposed) return;
		this.note("summary", { counts: this.counts, logError: this.logError });
		this.disposed = true;
		for (const off of this.cleanup.splice(0)) off();
		this.onChange = undefined;
		if (this.fd !== undefined) {
			try { fs.closeSync(this.fd); } catch { /* diagnostics are best-effort */ }
			this.fd = undefined;
		}
	}
}

export async function showFocusDiagnostics(
	ctx: ExtensionCommandContext, trace: FocusTrace, signal: AbortSignal,
	state: () => Record<string, unknown>, testMarker: (isCurrent: () => boolean) => void,
): Promise<void> {
	await ctx.ui.custom<undefined>((tui, _theme, _keys, done) => {
		let closed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let message = "先切到其他标签页再返回，全程不要键入，观察三层 IN/OUT。";
		const close = () => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", close);
			trace.onChange = undefined;
			done(undefined);
		};
		trace.attach(tui.terminal);
		trace.onChange = () => tui.requestRender();
		const helper = getNativeClipboard() as { enableVirtualTerminalInput?: () => boolean } | undefined;
		trace.note("context", {
			session: ctx.sessionManager.getSessionName(), tuiMode: tui.mode,
			nativeVTMethodAvailable: typeof helper?.enableVirtualTerminalInput === "function",
			// Availability is not proof that the earlier startup call succeeded.
			nativeVTStartupResult: "not observed in this already running Pi",
			state: state(),
		});
		signal.addEventListener("abort", close, { once: true });
		if (signal.aborted) close();
		return {
			render(width: number) {
				const lines = [
					"notify-dot 焦点诊断（真实输入链路，无轮询）", "",
					message, "",
					...STAGES.map(stage => {
						const c = trace.counts[stage];
						return `${stage.padEnd(10)} IN ${c.focusIn}   OUT ${c.focusOut}   chunks ${c.chunks}`;
					}),
					trace.bufferAttached ? "buffer = Pi 当前实际 StdinBuffer" : "buffer 不可观测：本版本内部结构不同，不能据此认定事件丢失",
					`状态 ${JSON.stringify(state())}`, "",
					"空格：5 秒后模拟完成；切走至少 10 秒再返回，先别输入，检查标题是否消标。",
					"r：重新发送 1004 启用序列，再做切换对照。q / Esc / Ctrl+C：关闭诊断。",
					"只记录焦点、长度和计数，不记录键入文本。",
					`日志 ${trace.logPath}`,
					...(trace.logError ? [`日志错误 ${trace.logError}`] : []),
				];
				return lines.map(line => truncateToWidth(line, width));
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) { close(); return; }
				if (matchesKey(data, "space")) {
					if (timer) clearTimeout(timer);
					message = "请立即切走，至少等 10 秒再返回；返回时先别键入。5 秒后会模拟完成。";
					trace.note("test_armed");
					timer = setTimeout(() => {
						timer = undefined;
						if (closed || signal.aborted) return;
						trace.note("test_settled", { state: state() });
						testMarker(() => !closed && !signal.aborted);
						message = "模拟完成已触发。先观察返回时是否自动消标，再按键结束。";
						tui.requestRender();
					}, 5_000);
				} else if (matchesKey(data, "r")) {
					process.stdout.write(FOCUS_REPORT_ENABLE);
					trace.note("rearm_1004");
					message = "已重发 1004 启用序列。请再次切走、返回，全程不要键入。";
				}
				tui.requestRender();
			},
			dispose: close,
		};
	});
}

interface DiagnosticActions {
	bindContext(ctx: ExtensionContext): void;
	state(): Record<string, unknown>;
	testMarker(isCurrent: () => boolean): void;
}
interface Diagnostics {
	note(event: string, details?: Record<string, unknown>): void;
	extensionInput(data: string): void;
	dispose(): void;
}

/** Command registration, cancellation and trace resources share one owner. */
export function registerFocusDiagnostics(pi: ExtensionAPI, actions: DiagnosticActions): Diagnostics {
	let currentTrace: FocusTrace | undefined;
	let currentController: AbortController | undefined;
	pi.registerCommand("notifydiag", {
		description: "Observe notify-dot focus events at stdin, Pi buffer, and extension layers",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/notifydiag 需要交互式 TUI", "warning"); return; }
			if (currentController) { ctx.ui.notify("焦点诊断已打开", "warning"); return; }
			actions.bindContext(ctx);
			const controller = new AbortController();
			currentController = controller;
			let trace: FocusTrace | undefined;
			try {
				trace = new FocusTrace();
				currentTrace = trace;
				const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
				await showFocusDiagnostics(ctx, trace, signal, actions.state, actions.testMarker);
			} catch (error) {
				ctx.ui.notify(`焦点诊断失败：${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				const interrupted = controller.signal.aborted || ctx.signal?.aborted;
				controller.abort();
				trace?.dispose();
				if (currentTrace === trace) currentTrace = undefined;
				if (currentController === controller) currentController = undefined;
				if (trace && !interrupted) ctx.ui.notify(`焦点日志：${trace.logPath}`, "info");
			}
		},
	});
	return {
		note(event, details) { currentTrace?.note(event, details); },
		extensionInput(data) { currentTrace?.record("extension", data); },
		dispose() {
			currentController?.abort();
			currentTrace?.dispose();
			currentTrace = undefined;
		},
	};
}
