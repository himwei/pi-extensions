import { parseArgs, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readToolContracts } from "../shared/managed-tools.js";
import type { StateSnapshot } from "./state.js";

const coreTools = new Set(["read", "bash", "edit", "write", "find", "grep", "ls", "powershell", "codemode", "tool_search"]);
function patternMatches(pattern: string, name: string): boolean {
  return new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name);
}
function historicalRemovals(ctx: Pick<ExtensionContext, "sessionManager">): Set<string> {
  const removed = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "system") continue;
    for (const tool of entry.message.toolsRemoved ?? []) removed.add(tool.name);
    for (const tool of entry.message.toolsAdded ?? []) removed.delete(tool.name);
  }
  return removed;
}

/** Additions only; Pi remains responsible for actual registry/CLI filtering. */
export function planAutoAdd(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getSettings" | "events">,
  ctx: Pick<ExtensionContext, "sessionManager">, snapshot: StateSnapshot, argv: readonly string[]): string[] {
  if (snapshot.preferences.mode !== "auto") return [];
  const args = parseArgs([...argv]);
  if (args.noTools || args.diagnostics.some(diagnostic => diagnostic.type === "error")) return [];
  const configured = pi.getSettings().defaultTools;
  const permittedDefaults = configured === undefined ? undefined : SettingsManager.inMemory({ defaultTools: configured }).getDefaultTools();
  const contracts = readToolContracts(pi);
  const enabled = new Map(snapshot.items.filter(item => item.extension.source === "global" && item.enabled)
    .flatMap(item => (item.extension.tools ?? []).map(tool => [tool.name, tool.sourcePath] as const)));
  const active = new Set(pi.getActiveTools());
  const removed = historicalRemovals(ctx);
  return pi.getAllTools().filter(tool => {
    if (active.has(tool.name) || coreTools.has(tool.name) || removed.has(tool.name) || tool.sourceInfo.path.startsWith("builtin:") ||
      tool.sourceInfo.path.startsWith("<") || enabled.get(tool.name) !== tool.sourceInfo.path) return false;
    const contract = contracts.get(tool.name);
    if (!contract?.defaultActive || contract.exposure !== tool.exposure || !["direct", "model-only"].includes(tool.exposure)) return false;
    if (permittedDefaults && !permittedDefaults.some(pattern => patternMatches(pattern, tool.name))) return false;
    if (args.excludeTools?.some(pattern => patternMatches(pattern, tool.name))) return false;
    if (args.tools) {
      const modifiers = args.tools.some(entry => /^[+-]/.test(entry));
      if (!modifiers && !args.tools.some(pattern => patternMatches(pattern, tool.name))) return false;
      if (modifiers) {
        const last = args.tools.filter(entry => entry.slice(1) === tool.name).at(-1);
        if (last?.startsWith("-")) return false;
      }
    }
    return true;
  }).map(tool => tool.name);
}
