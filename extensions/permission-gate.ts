import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createShellAuthorizer } from "./permission-gate/authorization.js";
import { detectSensitiveGlob, sensitivePathLabel } from "./permission-gate/policy.js";

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

export default function (pi: ExtensionAPI) {
  const authorizeShellCommand = createShellAuthorizer(pi);

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

    if (!(isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) || !hasStringProperty(event.input, "command")) {
      return undefined;
    }

    const reason = await authorizeShellCommand(event.input.command, ctx, {
      signal: ctx.signal, toolName: event.toolName, callId: event.toolCallId,
      audit: (type, data) => pi.appendEntry(type, data),
    });
    return reason ? blockSensitive(reason) : undefined;
  });
}
