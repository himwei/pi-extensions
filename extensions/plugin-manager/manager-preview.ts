/** Shared manager screen; runManagerPreview supplies isolated, memory-only fixtures. */
import { Input, ProcessTerminal, TuiMainScreen, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { PreviewState } from "./preview-state.js";
import { SelectionState, type SaveTarget, type View, type Extension } from "./state.js";
import { PreviewStyle, extensionTable, renderFooter, renderHeader, renderSettings, renderTabs, views } from "./preview-ui.js";

interface Options {
  preview?: boolean; width?: number; theme?: "dark" | "light";
  scope?: SaveTarget; mode?: "default" | "auto"; tab?: View; panel?: "main" | "details" | "save";
}
type Panel = { kind: "details"; id: string };
export class ManagerScreen implements Component {
  private input = new Input({ prompt: "> ", placeholder: "Search extensions…", placeholderStyle: text => this.style.muted(text) });
  private state: SelectionState;
  private view: View;
  private panel?: Panel;
  private hasFocus = false;
  private selected = 0;
  private selectedSetting = 0;
  private theme: "dark" | "light";
  private style: PreviewStyle;
  private notice = "";
  private saving = false;
  private disposed = false;
  onChange = () => {};
  onClose = () => {};
  onError = (_message: string) => {};
  afterSave = async () => {};
  constructor(private options: Options, private rows: () => number = () => 32, state?: SelectionState, style?: PreviewStyle) {
    this.state = state ?? new PreviewState(options.mode === "auto", options.scope);
    this.view = options.tab ?? "all";
    this.theme = options.theme ?? "dark";
    this.style = style ?? new PreviewStyle(this.theme);
    if (options.panel === "details" && this.state.extensions.length) this.panel = { kind: "details", id: this.state.extensions[0].id };
    // Preserve the old preview option by opening its replacement in Settings.
    if (options.panel === "save") { this.view = "settings"; this.selectedSetting = 1; }
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.updateInputFocus(); }
  private updateInputFocus() { this.input.focused = this.hasFocus && !this.panel && this.view !== "settings"; }
  invalidate() { this.input.invalidate(); }
  dispose() { this.disposed = true; }
  private get candidates() {
    const query = this.input.getValue().trim().toLocaleLowerCase();
    return this.state.extensions.filter(extension =>
      `${extension.name} ${extension.summary ?? ""} ${extension.description ?? ""} ${extension.path}`.toLocaleLowerCase().includes(query));
  }
  private get items() {
    return this.candidates.filter(extension => this.view === "selected" ? this.state.selected(extension) :
      this.view === "unselected" ? !this.state.selected(extension) : true);
  }
  private async saveChanges() {
    if (!this.state.dirty) { this.notice = "No changes"; return; }
    const hadSelections = this.state.changes.length > 0;
    const canSaveSelections = this.state.changes.some(extension => this.state.saveTarget === "project" || extension.source === "global");
    this.saving = true; this.notice = "Saving…"; this.onChange();
    try {
      const remaining = await this.state.save();
      await this.afterSave();
      if (remaining) this.notice = canSaveSelections ? "Partial save; use Project" : "Use Save to: Project";
      else this.notice = hadSelections ? "Selections and settings saved" : "Settings saved";
    } catch (error) {
      this.notice = "Save failed; see notification";
      if (!this.disposed) this.onError(error instanceof Error ? error.message : "Save failed");
    } finally { this.saving = false; if (!this.disposed) this.onChange(); }
  }
  handleInput(data: string) {
    if (this.saving || this.disposed) return;
    if (matchesKey(data, "ctrl+c")) { this.onClose(); return; }
    if (matchesKey(data, "escape")) {
      if (this.panel) { this.panel = undefined; this.updateInputFocus(); this.onChange(); }
      else this.onClose();
      return;
    }
    if (this.panel) {
      const id = this.panel.id;
      const extension = this.state.extensions.find(item => item.id === id);
      if (matchesKey(data, "enter")) this.panel = undefined;
      else if (matchesKey(data, "r") && extension?.source === "global") {
        this.state.usePersonalDefault(extension);
        this.notice = "Default selected; save to Project";
      }
      this.updateInputFocus(); this.onChange(); return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.view = views[(views.indexOf(this.view) + (matchesKey(data, "shift+tab") ? 3 : 1)) % views.length];
      this.selected = 0; this.notice = "";
    } else if (matchesKey(data, "ctrl+s")) void this.saveChanges();
    else if (matchesKey(data, "f9")) {
      if (!this.state.demo) return;
      this.theme = this.theme === "dark" ? "light" : "dark";
      this.style.setAppearance(this.theme);
      this.invalidate();
    }
    else if (matchesKey(data, "f6")) {
      if (!(this.state instanceof PreviewState)) return;
      this.state.resume();
      this.notice = `Resumed: ${this.state.activeTools.length} tools`;
    } else if (matchesKey(data, "f3")) {
      if (!(this.state instanceof PreviewState)) return;
      this.state.discover(); this.view = "all"; this.selected = 0; this.input.setValue("");
      this.notice = "Discovered json-tools.ts";
    } else if (this.view === "settings") {
      if (matchesKey(data, "up") || matchesKey(data, "down")) this.selectedSetting = matchesKey(data, "up") ? 0 : 1;
      else if (matchesKey(data, "left") || matchesKey(data, "right") || data === " " || matchesKey(data, "enter")) {
        if (this.selectedSetting === 0) this.state.autoAdd = !this.state.autoAdd;
        else this.state.saveTarget = this.state.saveTarget === "project" ? "global" : "project";
        this.notice = "";
      }
    } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + (matchesKey(data, "up") ? -1 : 1)));
    } else if (data === " " || matchesKey(data, "enter")) {
      const extension = this.items[this.selected];
      if (extension) {
        if (matchesKey(data, "enter")) this.panel = { kind: "details", id: extension.id };
        else { this.state.toggle(extension); this.notice = ""; }
      }
    } else { this.input.handleInput(data); this.selected = 0; }
    this.updateInputFocus(); this.onChange();
  }
  private footer(width: number, range?: string, extension?: Extension): string[] {
    return renderFooter(this.style, width, {
      view: extension ? "details" : this.view,
      saveTarget: this.state.saveTarget,
      unsaved: this.state.changes.length + Number(this.state.preferenceDirty) + Number(this.state.destinationDirty),
      notice: this.notice,
      range,
      canInherit: extension?.source === "global",
      reloadRequired: this.state.reloadRequired,
    });
  }
  private renderDetails(width: number, extension: Extension): string[] {
    const wrap = (text: string) => wrapTextWithAnsi(text, width);
    const override = this.state.projectOverride(extension);
    const lines = [this.style.border(width), "", renderHeader(this.style, width, "Extension details", this.state), "", extension.name];
    if (extension.summary) lines.push(...wrap(this.style.muted(extension.summary)));
    if (extension.description) lines.push(...wrap(extension.description));
    lines.push("", ...wrap(`Selected: ${this.state.selected(extension) ? "Yes" : "No"}${this.state.pending(extension) ? " (unsaved)" : ""}`),
      ...wrap(`Scope: ${extension.source === "global" ? "Global" : "Project"}`),
      ...wrap(`Personal default: ${extension.source === "global" ? this.state.personalDefault(extension) ? "Enabled" : "Disabled" : "Not applicable"}`),
      ...wrap(`Project override: ${override === undefined ? "Inherit" : override ? "Enabled" : "Disabled"}`),
      ...wrap(this.style.dim(extension.path)), "", this.style.muted(this.state.demo ? "Tools (simulated)" : "Registered tools"));
    for (const tool of extension.tools ?? []) lines.push(...wrap(`  ${tool.name} · ${this.state.activeTools.includes(tool.name) ? "Available" : tool.auto ? "Not declared" : "Manual activation"}`));
    if (!extension.tools?.length) lines.push(...wrap(this.style.muted("No registered model tools found.")));
    lines.push("", this.style.muted("Session tool list"), ...wrap(this.state.activeTools.join(" · ")),
      "", this.style.muted(`Save to: ${this.state.saveTarget === "project" ? "Project" : "Global"}`),
      ...wrap(this.style.dim(this.state.paths[this.state.saveTarget])), "", ...this.footer(width, undefined, extension), this.style.border(width));
    return lines.map(line => truncateToWidth(line, width, "…"));
  }
  render(width: number): string[] {
    const w = Math.max(12, width);
    if (this.panel) {
      const id = this.panel.id;
      return this.renderDetails(w, this.state.extensions.find(extension => extension.id === id)!);
    }
    const candidates = this.candidates;
    const selected = candidates.filter(extension => this.state.selected(extension)).length;
    const counts = { all: candidates.length, selected, unselected: candidates.length - selected, settings: 0 };
    const lines = [this.style.border(w), "", renderHeader(this.style, w, "Extensions", this.state),
      renderTabs(this.style, w, this.view, counts), this.style.dim("Tab to switch views")];
    if (this.view === "settings") {
      lines.push("", ...renderSettings(this.style, w, { paths: this.state.paths, selected: this.selectedSetting, autoAdd: this.state.autoAdd,
        savedAutoAdd: this.state.savedAutoAdd, saveTarget: this.state.saveTarget, savedSaveTarget: this.state.savedSaveTarget }),
        "", ...this.footer(w), this.style.border(w));
      return lines;
    }
    lines.push("", this.options.preview ? "> " + this.style.muted("Search extensions…") : this.input.render(w)[0] ?? "", "");
    const table = extensionTable(this.style, this.state.extensions, w);
    lines.push(table.header);
    const items = this.items;
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const visible = Math.max(1, this.rows() - lines.length - 4);
    const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), items.length - visible));
    for (const extension of items.slice(start, start + visible)) {
      lines.push(table.row(extension, extension === items[this.selected], this.state.selected(extension)));
    }
    if (!items.length) lines.push(this.style.muted("  No matching extensions."));
    const range = `${items.length ? start + 1 : 0}–${Math.min(items.length, start + visible)} / ${items.length}`;
    lines.push("", ...this.footer(w, range), this.style.border(w));
    return lines.map(line => truncateToWidth(line, w, "…"));
  }
}

export async function runManagerPreview(options: Options = {}): Promise<void> {
  if (options.preview) { console.log(new ManagerScreen(options).render(options.width ?? 104).join("\n")); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this demo in an interactive PowerShell 7 terminal, or use -Preview.");
  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal);
  const panel = new ManagerScreen(options, () => terminal.rows);
  const closed = new Promise<void>(resolve => { panel.onClose = resolve; });
  panel.onChange = () => ui.requestRender();
  ui.addChild(panel); ui.setFocus(panel);
  let started = false;
  try { started = true; ui.start(); await closed; }
  finally { if (started) ui.stop(); process.stdin.pause(); }
}
