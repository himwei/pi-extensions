/** Pure two-scope selection drafts. Persistence and Pi runtime are supplied by adapters. */
export type SaveTarget = "global" | "project";
export type ProjectChoice = "inherit" | "on" | "off";
export interface Extension { id: string; name: string; source: SaveTarget; path: string; tools?: Array<{ name: string }> }
export interface DraftSelection { enabled: boolean; choice: ProjectChoice }
export interface InventoryItem { extension: Extension; globalEnabled: boolean; projectChoice: ProjectChoice; enabled: boolean }
export interface StateSnapshot { items: InventoryItem[] }
export interface Selection { extension: Extension; scope: SaveTarget; enabled: boolean; inherit: boolean }
export interface SaveResult { snapshot: StateSnapshot; wroteSelections: boolean; error?: string }
export type SaveSelections = (selections: Selection[]) => Promise<SaveResult>;

export class SelectionState {
  extensions: Extension[] = [];
  private saved = new Map<string, DraftSelection>();
  private drafts = new Map<string, DraftSelection>();
  reloadRequired = false;
  reloads = 0;
  constructor(snapshot: StateSnapshot, readonly projectName: string, readonly demo = false,
    readonly projectTrusted = true, private saveSelections?: SaveSelections) { this.rebase(snapshot); }
  selection(entry: Extension): Readonly<DraftSelection> { return this.drafts.get(entry.id)!; }
  effective(entry: Extension, saved = false): boolean {
    const selection = (saved ? this.saved : this.drafts).get(entry.id)!;
    return selection.choice === "inherit" ? selection.enabled : selection.choice === "on";
  }
  changed(entry: Extension, scope?: SaveTarget): boolean {
    const draft = this.drafts.get(entry.id)!, saved = this.saved.get(entry.id)!;
    return scope === "global" ? draft.enabled !== saved.enabled : scope === "project" ? draft.choice !== saved.choice :
      draft.enabled !== saved.enabled || draft.choice !== saved.choice;
  }
  count(scope?: SaveTarget): number { return this.extensions.filter(entry => this.changed(entry, scope)).length; }
  canEdit(entry: Extension, scope: SaveTarget): boolean { return scope === "global" ? entry.source === "global" : this.projectTrusted; }
  toggle(entry: Extension, scope: SaveTarget): boolean {
    if (!this.canEdit(entry, scope)) return false;
    const draft = this.drafts.get(entry.id)!;
    if (scope === "global") draft.enabled = !draft.enabled;
    else draft.choice = this.effective(entry) ? "off" : "on";
    return true;
  }
  inherit(entry: Extension): boolean {
    if (entry.source !== "global" || !this.projectTrusted) return false;
    this.drafts.get(entry.id)!.choice = "inherit";
    return true;
  }
  get selections(): Selection[] {
    return this.extensions.flatMap(extension => {
      const draft = this.selection(extension);
      const selections: Selection[] = [];
      if (this.changed(extension, "global")) selections.push({ extension, scope: "global", enabled: draft.enabled, inherit: false });
      if (this.changed(extension, "project")) selections.push({ extension, scope: "project", enabled: draft.choice === "on", inherit: draft.choice === "inherit" });
      return selections;
    });
  }
  private snapshot(): StateSnapshot {
    return { items: this.extensions.map(extension => ({ extension, globalEnabled: this.selection(extension).enabled,
      projectChoice: this.selection(extension).choice, enabled: this.effective(extension) })) };
  }
  private rebase(snapshot: StateSnapshot, keep: Selection[] = []): void {
    this.extensions = snapshot.items.map(item => item.extension);
    this.saved.clear(); this.drafts.clear();
    for (const item of snapshot.items) {
      const value = { enabled: item.globalEnabled, choice: item.projectChoice };
      this.saved.set(item.extension.id, { ...value }); this.drafts.set(item.extension.id, { ...value });
    }
    for (const selection of keep) {
      const draft = this.drafts.get(selection.extension.id);
      if (!draft) continue;
      if (selection.scope === "global") draft.enabled = selection.enabled;
      else draft.choice = selection.inherit ? "inherit" : selection.enabled ? "on" : "off";
    }
  }
  async apply(): Promise<{ changes: number; effectiveChanges: number }> {
    const selections = this.selections;
    const changes = this.count();
    const effectiveChanges = this.extensions.filter(entry => this.effective(entry) !== this.effective(entry, true)).length;
    if (!selections.length) return { changes: 0, effectiveChanges: 0 };
    if (this.saveSelections) {
      const result = await this.saveSelections(selections);
      this.reloadRequired ||= result.wroteSelections;
      this.rebase(result.snapshot, selections);
      if (result.error) throw new Error(result.error);
      if (this.count()) throw new Error("Some choices were not saved. Review pending cells before applying again.");
    } else {
      if (!this.demo) throw new Error("No native configuration adapter is available.");
      this.rebase(this.snapshot()); this.reloads++;
    }
    return { changes, effectiveChanges };
  }
}
