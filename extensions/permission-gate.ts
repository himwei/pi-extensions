import { createHash, randomUUID } from "node:crypto";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { overlayDecision, type GateDialogData, type GateOutcome } from "./permission-gate/dialog.js";
import {
  buildCommandPreview,
  deletionTargetPath,
  detectDangerousCommandInfo,
  detectSensitiveGlob,
  detectSensitiveShellAccess,
  sensitivePathLabel,
} from "./permission-gate/policy.js";

const PREVIEW_MAX_LINES = 3;

/** Commands approved with [a] this session, keyed by sha256 of the exact command text.
 * Cleared on session_start; a different command string still prompts. */
const sessionAllowedHashes = new Set<string>();

export function clearSessionAllowlist(): void {
  sessionAllowedHashes.clear();
}

function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized;
}

function blockSensitive(reason: string) {
  return { block: true as const, reason };
}

function hasStringProperty<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

/** Shared by bash's tool-call hook and run-script after capturing its source snapshot.
 * This is a high-confidence heuristic, not a sandbox or recursive dependency scanner. */
export async function authorizeShellCommand(
  command: string,
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "mode" | "cwd">,
  options: { signal?: AbortSignal; toolName?: string; callId?: string; audit?: ExtensionAPI["appendEntry"] } = {},
): Promise<string | undefined> {
  if (options.signal?.aborted) return "Blocked: authorization cancelled";
  const secretLabel = detectSensitiveShellAccess(command);
  if (secretLabel) {
    if (ctx.hasUI) ctx.ui.notify(`已拦截可能触及敏感文件的命令：${secretLabel}`, "warning");
    return `Blocked shell access that may touch secrets (${secretLabel}): ${commandPreview(command)}`;
  }
  const sourceHash = createHash("sha256").update(command).digest("hex");
  if (sessionAllowedHashes.has(sourceHash)) {
    // Same command approved with [a] earlier this session: pass silently, audit-only.
    options.audit?.("approval-decided", {
      outcome: "allowed-session", auto: true,
      toolName: options.toolName ?? "shell", callId: options.callId, sourceHash,
    });
    return undefined;
  }
  const info = detectDangerousCommandInfo(command);
  if (!info) return undefined;
  const id = randomUUID();
  options.audit?.("approval-asked", { id, toolName: options.toolName ?? "shell", callId: options.callId,
    reason: info.label, sourceHash });
  const dialog: GateDialogData = {
    zh: info.zh,
    severity: info.severity,
    consequence: info.consequence,
    target: info.extractTarget ? deletionTargetPath(command, ctx.cwd) : undefined,
    preview: buildCommandPreview(command, PREVIEW_MAX_LINES),
    danger: { start: info.index, end: info.end },
  };
  let outcome: GateOutcome = "unavailable";
  if (ctx.hasUI) {
    if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
      outcome = await overlayDecision(ctx.ui, dialog, options.signal);
    } else {
      // Dialog-capable fallback (e.g. RPC mode): compact text via built-in confirm.
      const signal = options.signal;
      let onAbort: (() => void) | undefined;
      try {
        const decision = Promise.resolve().then(() => ctx.ui.confirm("危险命令确认",
          `检测到 ${info.zh}：\n\n${commandPreview(command)}\n\n${info.consequence}\n\n是否允许执行？`, { signal }));
        const confirmed = signal ? await Promise.race([
          decision,
          new Promise<boolean>(resolve => {
            onAbort = () => resolve(false);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]) : await decision;
        outcome = signal?.aborted ? "cancelled" : confirmed ? "allowed-once" : "rejected";
      } catch {
        outcome = signal?.aborted ? "cancelled" : "unavailable";
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    }
  }
  if (outcome === "allowed-session") sessionAllowedHashes.add(sourceHash);
  options.audit?.("approval-decided", { id, outcome, sourceHash });
  return outcome === "allowed-once" || outcome === "allowed-session"
    ? undefined
    : `Blocked (${outcome}): ${info.label}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    clearSessionAllowlist();
  });

  pi.on("tool_call", async (event, ctx) => {
    // File tools: hard-block sensitive paths (no confirmation).
    if (
      (isToolCallEventType("read", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)) &&
      hasStringProperty(event.input, "path")
    ) {
      const path = event.input.path;
      const label = sensitivePathLabel(path, ctx.cwd);
      if (label) {
        if (ctx.hasUI) {
          ctx.ui.notify(`已拦截对敏感文件的访问：${label}`, "warning");
        }
        return blockSensitive(`Blocked access to sensitive path (${label}): ${path}`);
      }
      return undefined;
    }

    // Grep: hard-block searches that explicitly target sensitive files via `path` or `glob`.
    // Residual risk: a bare grep over cwd could still surface .env contents; blocking that
    // would make grep unusable, so it is accepted intentionally.
    if (isToolCallEventType("grep", event)) {
      if (hasStringProperty(event.input, "path")) {
        const label = sensitivePathLabel(event.input.path, ctx.cwd);
        if (label) {
          if (ctx.hasUI) {
            ctx.ui.notify(`已拦截对敏感文件的搜索：${label}`, "warning");
          }
          return blockSensitive(`Blocked grep on sensitive path (${label}): ${event.input.path}`);
        }
      }
      if (hasStringProperty(event.input, "glob")) {
        const secretLabel = detectSensitiveGlob(event.input.glob);
        if (secretLabel) {
          if (ctx.hasUI) {
            ctx.ui.notify(`已拦截针对敏感文件的搜索 glob：${secretLabel}`, "warning");
          }
          return blockSensitive(`Blocked grep glob that may touch secrets (${secretLabel}): ${event.input.glob}`);
        }
      }
      return undefined;
    }

    if (!isToolCallEventType("bash", event) || !hasStringProperty(event.input, "command")) {
      return undefined;
    }

    const reason = await authorizeShellCommand(event.input.command, ctx, {
      signal: ctx.signal, toolName: event.toolName, callId: event.toolCallId,
      audit: (type, data) => pi.appendEntry(type, data),
    });
    return reason ? blockSensitive(reason) : undefined;
  });
}
