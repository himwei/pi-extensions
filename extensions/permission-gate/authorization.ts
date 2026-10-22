import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessCommand } from "./assessment.js";
import { overlayDecision, type GateDialogData, type GateOutcome } from "./dialog.js";
import { detectElevationIntents, type ElevationIntent } from "./elevation.js";
import { buildCommandPreview, deletionTargetPath, detectSensitiveShellAccess } from "./policy.js";

export type AuthorizationContext = Pick<ExtensionContext, "hasUI" | "ui" | "mode" | "cwd"> &
  Partial<Pick<ExtensionContext, "sessionManager">>;

export interface AuthorizationOptions {
  signal?: AbortSignal;
  toolName?: string;
  callId?: string;
  audit?: ExtensionAPI["appendEntry"];
  /** The bash tool uses PowerShell; run-script supplies its actual language. */
  language?: "powershell" | "bash" | "python";
  /** Original physical script and raw-byte SHA-256, supplied by run-script. */
  script?: { path: string; version: string };
  distro?: string;
}

function sessionId(ctx?: Partial<AuthorizationContext>): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized;
}

/** Missing or unresolved identity disables session grants, while once remains
 * available. Include lexical and real paths: either can affect script semantics. */
async function permissionKey(sourceHash: string, id: string | undefined, ctx: AuthorizationContext, options: AuthorizationOptions) {
  if (!id || typeof ctx.cwd !== "string" || !ctx.cwd.trim()) return undefined;
  if (options.toolName === "run-script" && !options.script) return undefined;
  if (options.script && (!options.script.path.trim() || !/^[a-f\d]{64}$/i.test(options.script.version))) return undefined;
  try {
    const cwd = resolve(ctx.cwd);
    const cwdReal = await realpath(cwd);
    const scriptPath = options.script ? resolve(cwd, options.script.path) : undefined;
    const scriptReal = scriptPath ? await realpath(scriptPath) : undefined;
    return createHash("sha256").update(JSON.stringify({
      session: id, cwd, cwdReal, language: options.language ?? "powershell", tool: options.toolName ?? "shell",
      sourceHash, scriptPath, scriptReal, scriptVersion: options.script?.version, distro: options.distro ?? null,
    })).digest("hex");
  } catch { return undefined; }
}

/** Each extension entry owns an instance and registers its lifecycle explicitly.
 * Factories cached by Pi can be reused without retaining an earlier instance's grants. */
export function createShellAuthorizer(pi: Pick<ExtensionAPI, "on" | "appendEntry">) {
  const makeSession = (ctx?: Partial<AuthorizationContext>, active = true) => ({
    id: sessionId(ctx), active, controller: new AbortController(), grants: new Set<string>(),
  });
  let session = makeSession();
  const reset = (ctx?: Partial<AuthorizationContext>, active = true) => {
    const previous = session;
    session = makeSession(ctx, active);
    previous.grants.clear();
    previous.controller.abort();
  };
  pi.on("session_start", (_event, ctx) => { reset(ctx); });
  pi.on("session_shutdown", () => { reset(undefined, false); });

  return async function authorizeShellCommand(
    command: string, ctx: AuthorizationContext, options: AuthorizationOptions = {},
  ): Promise<string | undefined> {
    const owner = session;
    const id = sessionId(ctx);
    if (options.signal?.aborted) return "Blocked: authorization cancelled";
    if (!owner.active || (owner.id !== undefined && owner.id !== id)) return "Blocked: authorization session is no longer current";
    owner.id ??= id;
    const current = () => session === owner && owner.active && owner.id === id && sessionId(ctx) === id;
    const signal = options.signal ? AbortSignal.any([options.signal, owner.controller.signal]) : owner.controller.signal;
    const audit: NonNullable<AuthorizationOptions["audit"]> = (type, data) => {
      if (current()) (options.audit ?? ((type, data) => pi.appendEntry(type, data)))(type, data);
    };
    const cancelled = () => signal.aborted || !current();
    const secretLabel = detectSensitiveShellAccess(command);
    if (secretLabel) {
      if (ctx.hasUI) ctx.ui.notify(`已拦截可能触及敏感文件的命令：${secretLabel}`, "warning");
      return `Blocked shell access that may touch secrets (${secretLabel}): ${commandPreview(command)}`;
    }
    const sourceHash = createHash("sha256").update(command).digest("hex");
    let elevation: ElevationIntent[];
    try {
      elevation = options.language && options.language !== "powershell" ? [] : await detectElevationIntents(command, signal);
    } catch {
      const outcome = cancelled() ? "cancelled" : "unavailable";
      audit("approval-decided", { outcome, toolName: options.toolName ?? "shell", callId: options.callId,
        sourceHash, reason: "elevation-analysis", phase: "analysis" });
      return cancelled() ? "Blocked: authorization cancelled" :
        "Blocked: elevation inspection unavailable. Check PowerShell Core 7+ and PI_POWERSHELL_EXE before retrying; the command was not authorized.";
    }
    if (cancelled()) return "Blocked: authorization cancelled";
    const assessment = assessCommand(command, elevation);
    if (!assessment) return undefined;
    const contextHash = await permissionKey(sourceHash, id, ctx, options);
    if (cancelled()) return "Blocked: authorization cancelled";
    const allowSession = !!contextHash && !assessment.requiresReadiness;
    if (allowSession && owner.grants.has(contextHash)) {
      audit("approval-decided", { outcome: "allowed-session", auto: true,
        toolName: options.toolName ?? "shell", callId: options.callId, sourceHash, contextHash });
      return undefined;
    }
    const info = assessment.reasons[0]!;
    const metadata = { id: randomUUID(), toolName: options.toolName ?? "shell", callId: options.callId,
      reason: info.label, reasons: [...new Set(assessment.reasons.map(reason => reason.label))],
      requiresReadiness: assessment.requiresReadiness, sourceHash, ...(contextHash ? { contextHash } : {}) };
    const askedAt = performance.now();
    audit("approval-asked", metadata);
    const dialog: GateDialogData = {
      zh: assessment.zh, severity: assessment.severity, consequence: assessment.consequence,
      target: assessment.reasons.some(reason => reason.extractTarget) ? deletionTargetPath(command, ctx.cwd) : undefined,
      preview: buildCommandPreview(command, 3), danger: { start: info.index, end: info.end },
      additionalDangers: assessment.reasons.slice(1).map(reason => ({ start: reason.index, end: reason.end })),
      allowSession, onceLabel: assessment.requiresReadiness ? "已就绪，执行一次" : undefined,
      rejectLabel: assessment.requiresReadiness ? "取消此次（默认）" : undefined,
    };
    let outcome: GateOutcome = "unavailable";
    if (ctx.hasUI) {
      if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
        try { outcome = await overlayDecision(ctx.ui, dialog, signal); }
        catch { outcome = cancelled() ? "cancelled" : "unavailable"; }
      } else {
        let onAbort: (() => void) | undefined;
        try {
          const decision = Promise.resolve().then(() => cancelled() ? false : ctx.ui.confirm(
            assessment.requiresReadiness ? "提权执行就绪确认" : "危险命令确认",
            `检测到 ${assessment.zh}：\n\n${commandPreview(command)}\n\n${assessment.consequence}\n\n` +
            (assessment.requiresReadiness ? "确认表示已准备处理系统提权提示，仅执行本次。" : "是否允许执行？"), { signal }));
          const confirmed = await Promise.race([decision, new Promise<boolean>(resolve => {
            onAbort = () => resolve(false);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          })]);
          outcome = cancelled() ? "cancelled" : confirmed ? "allowed-once" : "rejected";
        } catch { outcome = cancelled() ? "cancelled" : "unavailable"; }
        finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
      }
    }
    let contextChanged = false;
    if (cancelled()) outcome = "cancelled";
    else if (outcome === "allowed-session" && !allowSession) outcome = "rejected";
    else if ((outcome === "allowed-once" || outcome === "allowed-session") && contextHash) {
      contextChanged = await permissionKey(sourceHash, id, ctx, options) !== contextHash;
      if (cancelled() || contextChanged) outcome = "cancelled";
    }
    if (outcome === "allowed-session" && contextHash) owner.grants.add(contextHash);
    audit("approval-decided", { ...metadata, outcome, waitedMs: Math.max(0, Math.round(performance.now() - askedAt)),
      ...(contextChanged ? { contextChanged: true } : {}) });
    return outcome === "allowed-once" || outcome === "allowed-session" ? undefined :
      `Blocked (${outcome}): ${contextChanged ? "execution context changed; confirm again. " : ""}${assessment.reasons.map(reason => reason.label).join(", ")}`;
  };
}
