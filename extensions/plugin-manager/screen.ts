/** Shared single-table UI. Persistence is injected; reload belongs to the command handler. */
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { ManagerStyle, renderHeader, type Relation } from "./ui.js";
import { SelectionState, type Extension, type SaveTarget } from "./state.js";
export interface ScreenOptions { preview?: boolean; column?: SaveTarget }
const title = (value: string) => value[0].toUpperCase() + value.slice(1);
const cell = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "…", true);
export class ManagerScreen implements Component {
  private input: Input;
  private scope: SaveTarget;
  private selected = 0;
  private notice: string;
  private saving = false;
  private hasFocus = false;
  private disposed = false;
  onChange = () => {};
  onClose = (_apply = false) => {};
  onError = (_message: string) => {};
  constructor(readonly state: SelectionState, private style: ManagerStyle, private rows: () => number = () => 30, private options: ScreenOptions = {}) {
    this.input = new Input({ prompt: "> ", placeholder: "Search extensions…", placeholderStyle: text => this.style.muted(text) });
    this.scope = options.column ?? "project";
    this.notice = state.demo ? "Changes take effect after Apply · DEMO: memory only" : "Changes take effect after Apply";
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.input.focused = value; }
  invalidate() { this.input.invalidate(); }
  dispose() { this.disposed = true; }
  private get items(): Extension[] {
    const query = this.input.getValue().trim().toLocaleLowerCase();
    return this.state.extensions.filter(entry =>
      `${entry.name} ${entry.path} ${(entry.tools ?? []).map(tool => tool.name).join(" ")}`.toLocaleLowerCase().includes(query));
  }
  private normalizeSelection(): Extension | undefined {
    const items = this.items;
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const entry = items[this.selected];
    if (entry?.source === "project") this.scope = "project";
    return entry;
  }
  private relation(entry: Extension): Relation | undefined {
    if (entry.source !== "global") return undefined;
    return this.state.effective(entry) === this.state.selection(entry).enabled ? "match" : "different";
  }
  private paint(text: string, relation?: Relation, focused = false): string { return this.style.paint(text, relation, focused); }
  private async applyChanges(): Promise<void> {
    if (this.saving || this.disposed) return;
    this.saving = true; this.notice = "Saving…"; this.onChange();
    try {
      const result = await this.state.apply();
      if (this.disposed) return;
      if (!this.state.demo && (result.changes || this.state.reloadRequired)) { this.dispose(); this.onClose(true); return; }
      this.notice = result.changes ? `Applied ${result.changes} extensions in memory · simulated reload #${this.state.reloads}` : "No pending changes";
    } catch (error) {
      if (this.disposed) return;
      this.notice = this.state.reloadRequired ? "Partial save · review pending cells; saved changes need reload" : "Save failed · see notification";
      this.onError(error instanceof Error ? error.message : "Saving extension choices failed.");
    } finally { this.saving = false; if (!this.disposed) this.onChange(); }
  }
  handleInput(data: string): void {
    if (this.disposed || this.saving) return;
    const entry = this.normalizeSelection();
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) { this.onClose(); return; }
    if (matchesKey(data, "ctrl+s")) {
      void this.applyChanges(); return;
    } else if (matchesKey(data, "ctrl+r")) {
      if (entry && this.state.inherit(entry)) {
        this.scope = "project"; this.notice = "Project choice: Inherit · Ctrl+S applies changes";
      } else this.notice = !entry ? "No matching extension to change" : !this.state.projectTrusted ? "Project choices require trust; use /trust first" : "Project-local extension · no global default to inherit";
    } else if (matchesKey(data, "left")) {
      if (entry?.source === "project") this.notice = "Project-local extension · edit the Project column";
      else this.scope = "global";
    } else if (matchesKey(data, "right")) this.scope = "project";
    else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.scope = this.scope === "global" || entry?.source === "project" ? "project" : "global";
    } else if (matchesKey(data, "up")) this.selected--;
    else if (matchesKey(data, "down")) this.selected++;
    else if (matchesKey(data, "pageUp")) this.selected -= 8;
    else if (matchesKey(data, "pageDown")) this.selected += 8;
    else if (matchesKey(data, "space") || matchesKey(data, "enter")) {
      if (entry) {
        this.notice = this.state.toggle(entry, this.scope) ? "Changes take effect after Apply · Ctrl+S applies both columns" : "Project choices require trust; use /trust first";
      }
    } else { this.input.handleInput(data); this.selected = 0; }
    this.normalizeSelection();
    this.onChange();
  }
  private table(width: number) {
    const globalWidth = 8, projectWidth = 10;
    const nameWidth = Math.max(1, Math.min(36, width - 3 - 2 - globalWidth - projectWidth));
    const column = (label: string, scope: SaveTarget, size: number) => {
      const text = this.scope === scope ? this.style.heading(label) : this.style.dim(label);
      return cell(text, size);
    };
    const value = (entry: Extension, scope: SaveTarget, selected: boolean, size: number) => {
      const draft = this.state.selection(entry);
      const available = scope === "project" || entry.source === "global";
      const editable = this.state.canEdit(entry, scope);
      const text = !available ? "—" : scope === "global" ? draft.enabled ? "On" : "Off" : title(draft.choice);
      const dirty = editable && this.state.changed(entry, scope) ? "*" : "";
      const focused = selected && editable && this.scope === scope;
      const decorated = !editable ? this.style.dim(text) : this.paint(text + dirty, scope === "project" ? this.relation(entry) : undefined, focused);
      return cell(decorated, size);
    };
    return {
      header: this.style.dim(cell("", 3) + cell("Extension", nameWidth)) + " " + column("Global", "global", globalWidth) + " " + column("Project", "project", projectWidth),
      row: (entry: Extension, selected: boolean) => {
        const name = `${selected ? "→" : " "}  ` + cell(entry.name, nameWidth);
        return (selected ? this.style.accent(name) : name) + " " + value(entry, "global", selected, globalWidth) + " " + value(entry, "project", selected, projectWidth);
      },
    };
  }
  private explanation(entry?: Extension): string[] {
    if (!entry) return ["No matching extensions.", "", ""];
    const draft = this.state.selection(entry);
    const effective = this.state.effective(entry) ? "On" : "Off";
    const reason = entry.source === "project" ? "project-local extension." : draft.choice === "inherit" ?
      "inherits Global." : this.relation(entry) === "match" ? "explicitly set, matching Global." : `overrides Global ${draft.enabled ? "On" : "Off"}.`;
    return [`This project: ${effective} · ${reason}`,
      entry.source === "global" ? `Global default: ${draft.enabled ? "On" : "Off"}.` : "Global: — · available only in this project.",
      entry.path];
  }
  private footer(width: number, range?: string): string[] {
    const counts = width >= 42 ? `Pending: Global ${this.state.count("global")} · Project ${this.state.count("project")}` :
      `Pending G:${this.state.count("global")} P:${this.state.count("project")}`;
    const suffix = range && width >= 58 ? this.style.dim(range) : "";
    const status = cell(counts, suffix ? Math.max(1, width - visibleWidth(suffix) - 2) : width) + (suffix ? "  " + suffix : "");
    const keys = width >= 90 ? "↑↓ move · ←→ column · Enter/Space toggle · Ctrl+R inherit · Ctrl+S apply · Esc discard" : width >= 72 ?
      "↑↓ move · ←→ column · Enter toggle · ^R inherit · ^S apply · Esc close" : width >= 52 ?
      "←→ col · Enter toggle · ^R inherit · ^S apply · Esc" : "←→ col · Enter · ^R · ^S";
    const legend = width >= 58 ? this.paint("Green", "match") + this.style.dim(": matches Global · ") + this.paint("Red", "different") + this.style.dim(": differs · * pending") :
      width >= 42 ? this.paint("Green", "match") + this.style.dim(": match · ") + this.paint("Red", "different") + this.style.dim(": differ · * pending") :
        this.paint("Green =", "match") + this.style.dim(" · ") + this.paint("Red ≠", "different") + this.style.dim(" · *");
    return [this.style.muted(status), legend, this.style.dim(this.notice), this.style.dim(keys)];
  }
  render(width: number): string[] {
    const w = Math.max(1, width);
    const entry = this.normalizeSelection();
    const lines = [this.style.border(w), "", renderHeader(this.style, w, this.state), "",
      this.options.preview ? "> " + this.style.muted("Search extensions…") : this.input.render(w)[0] ?? "", ""];
    const items = this.items;
    const table = this.table(w); lines.push(table.header);
    const capacity = Math.max(1, this.rows() - lines.length - 11);
    const start = Math.max(0, Math.min(this.selected - Math.floor(capacity / 2), items.length - capacity));
    for (const item of items.slice(start, start + capacity)) lines.push(table.row(item, item === entry));
    if (!items.length) lines.push(this.style.muted("  No matching extensions."));
    while (lines.length < 7 + capacity) lines.push("");
    const explanation = this.explanation(entry);
    lines.push("", ...explanation.map((text, i) => i === 2 ? this.style.dim(text) : this.style.muted(text)), "",
      ...this.footer(w, `${items.length ? start + 1 : 0}–${Math.min(items.length, start + capacity)} / ${items.length}`), this.style.border(w));
    return lines.map(line => truncateToWidth(line, w, "…"));
  }
}
