/** Selection drafts are independent of Pi, disk access and terminal rendering. */
export type SaveTarget = "global" | "project";
export type View = "all" | "unselected" | "selected" | "settings";
export interface SettingsPaths { global: string; project: string; preferences: string }
export interface Preferences { mode: "default" | "auto"; saveTarget: SaveTarget }
export interface Extension {
  id: string; name: string; source: SaveTarget; path: string;
  summary?: string; description?: string;
  tools?: Array<{ name: string; auto: boolean; exposure?: string; sourcePath?: string }>;
}
export interface Selection { extension: Extension; enabled: boolean; inherit: boolean }
export interface InventoryItem { extension: Extension; globalEnabled: boolean; projectOverride?: boolean; enabled: boolean }
export interface StateSnapshot { items: InventoryItem[]; preferences: Preferences }

export class SelectionState {
  extensions: Extension[];
  protected personal = new Map<string, boolean>();
  protected project = new Map<string, boolean>();
  protected draft = new Map<string, boolean>();
  protected inherit = new Set<string>();
  autoAdd: boolean;
  savedAutoAdd: boolean;
  saveTarget: SaveTarget;
  savedSaveTarget: SaveTarget;
  activeTools: string[] = [];
  reloadRequired = false;
  constructor(snapshot: StateSnapshot, readonly paths: SettingsPaths, readonly projectName: string, readonly demo = false) {
    this.extensions = [];
    this.autoAdd = this.savedAutoAdd = snapshot.preferences.mode === "auto";
    this.saveTarget = this.savedSaveTarget = snapshot.preferences.saveTarget;
    this.rebase(snapshot);
  }
  personalDefault(extension: Extension) { return this.personal.get(extension.id) ?? true; }
  projectOverride(extension: Extension) { return this.project.get(extension.id); }
  effective(extension: Extension) { return this.project.get(extension.id) ?? this.personalDefault(extension); }
  selected(extension: Extension) { return this.draft.get(extension.id) ?? this.effective(extension); }
  pending(extension: Extension) { return this.selected(extension) !== this.effective(extension) || this.inherit.has(extension.id); }
  get changes() { return this.extensions.filter(extension => this.pending(extension)); }
  get preferenceDirty() { return this.autoAdd !== this.savedAutoAdd; }
  get destinationDirty() { return this.saveTarget !== this.savedSaveTarget; }
  get dirty() { return this.changes.length > 0 || this.preferenceDirty || this.destinationDirty; }
  get preferences(): Preferences { return { mode: this.autoAdd ? "auto" : "default", saveTarget: this.saveTarget }; }
  get selections(): Selection[] { return this.changes.map(extension => ({ extension, enabled: this.selected(extension), inherit: this.inherit.has(extension.id) })); }
  toggle(extension: Extension) { this.draft.set(extension.id, !this.selected(extension)); this.inherit.delete(extension.id); }
  usePersonalDefault(extension: Extension) {
    if (extension.source !== "global") return;
    this.draft.set(extension.id, this.personalDefault(extension));
    if (this.project.has(extension.id)) this.inherit.add(extension.id);
  }
  /** Keep unapplied drafts when a global save leaves project overrides unresolved. */
  protected rebase(snapshot: StateSnapshot, keepDrafts = false) {
    const selections = keepDrafts ? this.selections : [];
    this.extensions = snapshot.items.map(item => item.extension);
    this.personal.clear(); this.project.clear(); this.draft.clear(); this.inherit.clear();
    for (const item of snapshot.items) {
      this.personal.set(item.extension.id, item.globalEnabled);
      if (item.projectOverride !== undefined) this.project.set(item.extension.id, item.projectOverride);
      this.draft.set(item.extension.id, item.enabled);
    }
    for (const selection of selections) {
      if (!this.extensions.some(extension => extension.id === selection.extension.id)) continue;
      this.draft.set(selection.extension.id, selection.enabled);
      if (selection.inherit && this.project.has(selection.extension.id)) this.inherit.add(selection.extension.id);
    }
    this.savedAutoAdd = snapshot.preferences.mode === "auto";
    this.savedSaveTarget = snapshot.preferences.saveTarget;
  }
  /** Memory implementation used only by the standalone demo. */
  async save(): Promise<number> {
    for (const { extension, enabled, inherit } of this.selections) {
      if (this.saveTarget === "project") {
        if (inherit || enabled === this.personalDefault(extension)) this.project.delete(extension.id);
        else this.project.set(extension.id, enabled);
        this.inherit.delete(extension.id);
      } else if (extension.source === "global") this.personal.set(extension.id, enabled);
    }
    this.savedAutoAdd = this.autoAdd;
    this.savedSaveTarget = this.saveTarget;
    return this.changes.length;
  }
}
