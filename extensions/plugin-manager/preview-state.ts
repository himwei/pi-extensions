/** In-memory fixtures and draft/save behavior for the manual preview. No file I/O. */
import { SelectionState, type Extension, type SaveTarget, type SettingsPaths } from "./state.js";
export type { Extension, SaveTarget, View } from "./state.js";
export const settingsPaths: SettingsPaths = {
  global: "~/.pi/agent/settings.json",
  project: "C:/work/demo-project/.pi/settings.json",
  preferences: "~/.pi/agent/plugin-manager.json",
};
const fixtures: Extension[] = [
  { id: "run-script", name: "run-script.ts", source: "global", path: "~/.pi/agent/extensions/run-script.ts", summary: "Check and execute scripts", description: "Its tool is registered but missing from the sample session's historical tool list.", tools: [{ name: "run-script", auto: true }] },
  { id: "web-search", name: "web-search.ts", source: "global", path: "~/.pi/agent/extensions/web-search.ts", summary: "Search and read web pages", description: "The sample project disables this extension through a project override.", tools: [{ name: "web_search", auto: true }, { name: "web_fetch", auto: true }] },
  { id: "powershell-bash", name: "powershell-bash.ts", source: "global", path: "~/.pi/agent/extensions/powershell-bash.ts", summary: "Enhanced PowerShell execution", description: "The optional powershell tool requires an explicit choice and is not added automatically.", tools: [{ name: "bash", auto: true }, { name: "powershell", auto: false }] },
  { id: "notify-dot", name: "notify-dot.ts", source: "global", path: "~/.pi/agent/extensions/notify-dot.ts", summary: "Completion and waiting alerts" },
  { id: "rmb-footer", name: "rmb-footer.ts", source: "global", path: "~/.pi/agent/extensions/rmb-footer.ts", summary: "CNY costs in the footer" },
  { id: "provider-loader", name: "provider-loader.ts", source: "global", path: "~/.pi/agent/extensions/provider-loader.ts", summary: "Custom model providers" },
  { id: "permission-gate", name: "permission-gate.ts", source: "global", path: "~/.pi/agent/extensions/permission-gate.ts", summary: "Command and credential guards" },
  { id: "ai-rename", name: "ai-rename.ts", source: "global", path: "~/.pi/agent/extensions/ai-rename.ts", summary: "Name sessions with the model" },
  { id: "auto-summary", name: "auto-summary.ts", source: "global", path: "~/.pi/agent/extensions/auto-summary.ts", summary: "Save or generate summaries" },
  { id: "local-tools", name: "project-tools.ts", source: "project", path: "C:/work/demo-project/.pi/extensions/project-tools.ts", summary: "Tools for this project", description: "Project-owned tools are outside the first automatic completion policy.", tools: [{ name: "project_inspect", auto: true }] },
];

export class PreviewState extends SelectionState {
  constructor(autoAdd = false, saveTarget: SaveTarget = "project") {
    super({ preferences: { mode: autoAdd ? "auto" : "default", saveTarget }, items: fixtures.map(extension => {
      const globalEnabled = !["ai-rename", "auto-summary"].includes(extension.id);
      return { extension: { ...extension }, globalEnabled, enabled: extension.id === "web-search" ? false : globalEnabled,
        ...(extension.id === "web-search" ? { projectOverride: false } : {}) };
    }) }, settingsPaths, "demo-project", true);
    this.resume();
  }
  discover() {
    if (this.extensions.some(extension => extension.id === "json-tools")) return;
    this.extensions.unshift({ id: "json-tools", name: "json-tools.ts", source: "global", path: "~/.pi/agent/extensions/json-tools.ts",
      summary: "Inspect JSON documents", description: "A newly discovered sample extension. No real file is created.", tools: [{ name: "json_inspect", auto: true }] });
  }
  resume() {
    // A fixed historical fixture, not Pi's actual loader, reload or session implementation.
    const active = new Set(["read", "bash", "edit", "write"]);
    if (this.savedAutoAdd) for (const extension of this.extensions) {
      if (extension.source !== "global" || !this.effective(extension)) continue;
      for (const tool of extension.tools ?? []) if (tool.auto) active.add(tool.name);
    }
    this.activeTools = [...active];
  }
}
