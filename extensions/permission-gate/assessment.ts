import type { ElevationIntent } from "./elevation.js";
import { detectDangerousCommands, type DangerousCommandInfo } from "./policy.js";

export interface CommandAssessment {
  reasons: DangerousCommandInfo[];
  requiresReadiness: boolean;
  zh: string;
  severity: "high" | "medium";
  consequence: string;
}

/** Pure policy composition; has no filesystem, interpreter, UI or session state. */
export function assessCommand(command: string, elevation: readonly ElevationIntent[]): CommandAssessment | undefined {
  const reasons: DangerousCommandInfo[] = [
    ...elevation.map(intent => ({
      label: `elevation (${intent.kind})`, zh: "管理员提权", severity: "high" as const,
      consequence: "确认后将发起提权，请准备处理系统提示",
      index: intent.index, end: intent.end, extractTarget: false,
    })),
    ...detectDangerousCommands(command),
  ];
  if (!reasons.length) return undefined;
  return {
    reasons,
    requiresReadiness: elevation.length > 0,
    zh: [...new Set(reasons.map(reason => reason.zh))].join(" + "),
    severity: reasons.some(reason => reason.severity === "high") ? "high" : "medium",
    consequence: [...new Set(reasons.map(reason => reason.consequence))].join("；"),
  };
}
