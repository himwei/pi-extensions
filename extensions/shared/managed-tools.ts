/** Explicit default-activation metadata, which Pi's public ToolInfo does not expose. */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
export const TOOL_CONTRACT_CHANNEL = "plugin-manager:tool-contracts:v1";
export interface ToolContract { name: string; defaultActive: boolean; exposure: string }
interface ContractRequest { collect(contracts: readonly ToolContract[]): void }
const registrations = new WeakMap<ExtensionAPI, Map<string, ToolContract>>();

export function registerManagedTool<T extends ToolDefinition>(pi: ExtensionAPI, tool: T): void {
  pi.registerTool(tool);
  // Older hosts and minimal test doubles still register exactly the original definition.
  if (!pi.events?.on) return;
  let contracts = registrations.get(pi);
  if (!contracts) {
    contracts = new Map();
    registrations.set(pi, contracts);
    const current = contracts;
    const unsubscribe = pi.events.on(TOOL_CONTRACT_CHANNEL, request => {
      if (request && typeof (request as ContractRequest).collect === "function") (request as ContractRequest).collect([...current.values()]);
    });
    pi.on("session_shutdown", () => { unsubscribe(); registrations.delete(pi); });
  }
  contracts.set(tool.name, { name: tool.name, defaultActive: tool.defaultActive !== false, exposure: tool.exposure ?? "direct" });
}

export function readToolContracts(pi: Pick<ExtensionAPI, "events">): Map<string, ToolContract> {
  const contracts = new Map<string, ToolContract>();
  pi.events.emit(TOOL_CONTRACT_CHANNEL, { collect(values: readonly ToolContract[]) {
    for (const value of values) contracts.set(value.name, value);
  } } satisfies ContractRequest);
  return contracts;
}
