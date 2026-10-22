import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigService } from "./plugin-manager/config.js";
import { ManagerScreen } from "./plugin-manager/screen.js";
import { ManagerStyle } from "./plugin-manager/ui.js";

export interface ManagerOptions { agentDir?: string }
export function registerPluginManager(pi: ExtensionAPI, options: ManagerOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  let generation = 0, busy = false;
  let closeScreen: (() => void) | undefined;
  pi.on("session_start", () => { generation++; closeScreen?.(); closeScreen = undefined; });
  pi.on("session_shutdown", () => { generation++; closeScreen?.(); closeScreen = undefined; });
  pi.registerCommand("plugins", {
    description: "Manage Global / Project extension switches: /plugins [status|reload]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const action = args.trim();
      if (action && action !== "status" && action !== "reload") { ctx.ui.notify("Usage: /plugins [status|reload]", "warning"); return; }
      if (busy) { ctx.ui.notify("Plugin manager is already open or applying changes.", "info"); return; }
      busy = true;
      const opened = generation;
      let reloading = false, selectionsSaved = false;
      try {
        await ctx.waitForIdle();
        if (opened !== generation) return;
        if (action === "reload") { reloading = true; await ctx.reload(); return; }
        const state = await new ConfigService(ctx.cwd, agentDir, ctx.isProjectTrusted(), () => opened === generation).open();
        if (opened !== generation) return;
        if (action === "status" || ctx.mode !== "tui") {
          const entries = state.extensions.map(extension => {
            const selected = state.selection(extension);
            return `${extension.name} · Global ${extension.source === "global" ? selected.enabled ? "On" : "Off" : "—"} · Project ${selected.choice} · This project ${state.effective(extension) ? "On" : "Off"}`;
          });
          ctx.ui.notify(entries.join("\n") + `\nActive tools: ${pi.getActiveTools().join(", ")}\nSelections are native configuration, not loading-health checks. Use /plugins in TUI to change them.`, "info");
          return;
        }
        const apply = await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
          const screen = new ManagerScreen(state, new ManagerStyle(theme), () => tui.terminal.rows);
          let closed = false;
          const finish = (apply = false) => { if (closed) return; closed = true; screen.dispose(); done(apply); };
          screen.onChange = () => { if (!closed) tui.requestRender(); };
          screen.onClose = finish;
          screen.onError = message => { if (opened === generation) ctx.ui.notify(message, "error"); };
          closeScreen = () => finish();
          return screen;
        });
        closeScreen = undefined;
        if (!apply || opened !== generation) return;
        selectionsSaved = true;
        await ctx.waitForIdle();
        if (opened !== generation) return;
        reloading = true;
        // Reload replaces this extension instance. Never use this ctx afterwards.
        await ctx.reload();
      } catch (error) {
        if (reloading || selectionsSaved) throw new Error(`${selectionsSaved ? "Extension settings were saved, but Pi reload failed" : "Pi reload failed"}: ${error instanceof Error ? error.message : String(error)}. Run /reload or restart Pi.`);
        if (opened === generation) ctx.ui.notify(error instanceof Error ? error.message : "Cannot open plugin manager.", "error");
      } finally { if (opened === generation) closeScreen = undefined; busy = false; }
    },
  });
}
export default registerPluginManager;
