import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigService, readPreferences } from "./plugin-manager/config.js";
import { join } from "node:path";
import { ManagerScreen } from "./plugin-manager/manager-preview.js";
import { PreviewStyle } from "./plugin-manager/preview-ui.js";
import { planAutoAdd } from "./plugin-manager/runtime.js";

export interface ManagerOptions { agentDir?: string; argv?: readonly string[] }
export function registerPluginManager(pi: ExtensionAPI, options: ManagerOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const argv = options.argv ?? process.argv.slice(2);
  let generation = 0;
  let pending = false;
  let closeScreen: (() => void) | undefined;
  const service = (ctx: ExtensionContext) => new ConfigService(ctx.cwd, agentDir, ctx.isProjectTrusted(), pi);
  const applyAuto = async (ctx: ExtensionContext) => {
    const started = generation;
    if ((await readPreferences(join(agentDir, "plugin-manager.json"))).mode !== "auto") return;
    const snapshot = await service(ctx).snapshot();
    if (started !== generation) return;
    const additions = planAutoAdd(pi, ctx, snapshot, argv);
    if (!additions.length) return;
    const before = pi.getActiveTools();
    pi.setActiveTools([...before, ...additions]);
    const active = new Set(pi.getActiveTools());
    const added = additions.filter(name => active.has(name));
    if (added.length) pi.appendEntry("plugin-manager-tools", { version: 1, reason: "auto", added });
  };
  const completeStartup = async (ctx: ExtensionContext) => {
    if (!pending) return;
    pending = false;
    try { await applyAuto(ctx); }
    catch (error) { ctx.ui.notify(`Plugin manager: ${error instanceof Error ? error.message : "Auto completion failed."}`, "warning"); }
  };
  pi.on("session_start", () => { generation++; pending = true; });
  // All session_start handlers (including dynamic shell registration) finish first.
  pi.on("resources_discover", async (_event, ctx) => { await completeStartup(ctx); });
  pi.on("before_agent_start", async (_event, ctx) => { await completeStartup(ctx); });
  pi.on("session_shutdown", () => { generation++; pending = false; closeScreen?.(); closeScreen = undefined; });

  pi.registerCommand("plugins", {
    description: "Manage custom extensions: /plugins [status|reload]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const action = args.trim();
      if (action === "reload") { await ctx.waitForIdle(); await ctx.reload(); return; }
      if (action && action !== "status") { ctx.ui.notify("Usage: /plugins [status|reload]", "warning"); return; }
      const opened = generation;
      try {
        await ctx.waitForIdle();
        const state = await service(ctx).open();
        if (opened !== generation) return;
        if (action === "status" || ctx.mode !== "tui") {
          ctx.ui.notify(`Mode: ${state.savedAutoAdd ? "Auto" : "Default"}\nSave to: ${state.savedSaveTarget === "project" ? "Project" : "Global"}\n` +
            state.extensions.map(extension => `[${state.selected(extension) ? "x" : " "}] ${extension.name} · ${extension.source}`).join("\n") +
            `\nActive tools: ${pi.getActiveTools().join(", ")}\nUse /plugins in TUI to change selections.`, "info");
          return;
        }
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          const screen = new ManagerScreen({}, () => tui.terminal.rows, state, new PreviewStyle(theme));
          screen.onChange = () => tui.requestRender();
          screen.onClose = () => done();
          screen.onError = message => ctx.ui.notify(message, "error");
          screen.afterSave = async () => {
            if (generation !== opened) return;
            await applyAuto(ctx);
            state.activeTools = pi.getActiveTools();
          };
          closeScreen = () => { screen.dispose(); done(); };
          return screen;
        });
      } catch (error) {
        if (opened === generation) ctx.ui.notify(error instanceof Error ? error.message : "Cannot open plugin manager.", "error");
      } finally { if (opened === generation) closeScreen = undefined; }
    },
  });
}
export default registerPluginManager;
