/**
 * One owner for read/edit/write: Pi factories and renderers, conservative
 * matching, session-local reading state, and checked in-place writes.
 * Content transforms remain ordered and idempotent; none are enabled.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ObservationStore } from "./write-transforms/observations.js";
import { createEnhancedTools } from "./write-transforms/tools.js";

export default function writeTransforms(pi: ExtensionAPI): void {
  const store = new ObservationStore();
  pi.on("session_start", (_event, ctx) => {
    store.clear();
    const tools = createEnhancedTools(ctx.cwd, { store });
    pi.registerTool(tools.read);
    pi.registerTool(tools.edit);
    pi.registerTool(tools.write);
  });
  pi.on("session_tree", () => store.clear());
  pi.on("session_compact", () => store.clear());
  pi.on("session_shutdown", () => store.clear());
}
