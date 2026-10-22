/** Native resource resolution and settings persistence; no tool activation or UI. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager, withFileMutationQueue, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import { SelectionState, type InventoryItem, type SaveResult, type SaveTarget, type Selection, type StateSnapshot } from "./state.js";

type NativeSettings = ReturnType<SettingsManager["getGlobalSettings"]>;
type Package = NonNullable<NativeSettings["packages"]>[number];
interface SettingsPair { global: NativeSettings; project: NativeSettings }
const slash = (path: string) => path.replace(/\\/g, "/");
export function pathKey(path: string): string {
  let canonical = resolve(path);
  try { canonical = realpathSync.native(canonical); } catch { /* Missing resources retain a lexical identity. */ }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
function localPath(path: string, base: string) { return resolve(base, path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path); }
function memorySettings(pair: SettingsPair, projectTrusted: boolean): SettingsManager {
  const storage = structuredClone(pair);
  return SettingsManager.fromStorage({ withLock(scope, fn) {
    const next = fn(JSON.stringify(storage[scope]));
    if (next !== undefined) storage[scope] = JSON.parse(next);
  } }, { projectTrusted });
}
const managed = (resource: ResolvedResource) => !resource.path.startsWith("builtin:") && resource.metadata.scope !== "temporary";
const target = (entry: string) => /^[!+-]/.test(entry) ? entry.slice(1) : entry;
function isExact(entry: string, path: string, base: string) {
  return !/[*?{}]/.test(target(entry)) && pathKey(localPath(target(entry), base)) === pathKey(path);
}
const sourceString = (pkg: Package) => typeof pkg === "string" ? pkg : pkg.source;
function samePackage(left: string, leftBase: string, right: string, rightBase: string): boolean {
  if (/^(?:npm:|git:|https?:|git@)/.test(left) || /^(?:npm:|git:|https?:|git@)/.test(right)) return left === right;
  return pathKey(localPath(left, leftBase)) === pathKey(localPath(right, rightBase));
}
const fields = (settings: NativeSettings) => JSON.stringify({ extensions: settings.extensions, packages: settings.packages });
const pair = (settings: SettingsManager): SettingsPair => ({ global: settings.getGlobalSettings(), project: settings.getProjectSettings() });

export class ConfigService {
  readonly paths: Record<SaveTarget, string>;
  private settings: SettingsManager;
  private resources = new Map<string, ResolvedResource>();
  private baseline?: StateSnapshot;
  private baselineSettings?: SettingsPair;
  constructor(readonly cwd: string, readonly agentDir: string, readonly projectTrusted: boolean, private isCurrent: () => boolean = () => true) {
    this.paths = { global: join(agentDir, "settings.json"), project: join(cwd, CONFIG_DIR_NAME, "settings.json") };
    this.settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  }
  private checkErrors(settings = this.settings): void {
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(`Cannot read or save ${errors.map(error => error.path ?? `${error.scope} settings`).join(", ")}: ${errors.map(error => error.error.message).join("; ")}. Repair Pi settings and reopen /plugins.`);
  }
  private checkCurrent(): void { if (!this.isCurrent()) throw new Error("This plugin manager belongs to an old runtime. Reopen /plugins."); }
  private async resolveSnapshot(settings: SettingsManager): Promise<{ snapshot: StateSnapshot; resources: Map<string, ResolvedResource> }> {
    const resolveResources = (manager: SettingsManager) => new DefaultPackageManager({ cwd: this.cwd, agentDir: this.agentDir, settingsManager: manager }).resolve(async () => "skip");
    const [inherited, effective] = await Promise.all([
      resolveResources(memorySettings({ global: settings.getGlobalSettings(), project: {} }, false)), resolveResources(settings),
    ]);
    const globals = new Map(inherited.extensions.filter(managed).map(resource => [pathKey(resource.path), resource]));
    const combined = new Map(effective.extensions.filter(managed).map(resource => [pathKey(resource.path), resource]));
    const resources = new Map<string, ResolvedResource>();
    const items: InventoryItem[] = [];
    for (const [id, resource] of new Map([...globals, ...combined])) {
      const global = globals.get(id), current = combined.get(id) ?? global!, owner = global ?? resource;
      resources.set(id, owner);
      const source = global ? "global" : "project";
      items.push({ extension: { id, name: basename(owner.path), source, path: owner.path }, globalEnabled: global?.enabled ?? current.enabled,
        projectChoice: source === "project" || current.metadata.scope === "project" ? current.enabled ? "on" : "off" : "inherit", enabled: current.enabled });
    }
    items.sort((left, right) => left.extension.source.localeCompare(right.extension.source) || left.extension.name.localeCompare(right.extension.name));
    return { snapshot: { items }, resources };
  }
  async snapshot(): Promise<StateSnapshot> {
    await this.settings.reload(); this.checkErrors();
    const result = await this.resolveSnapshot(this.settings);
    this.resources = result.resources;
    return result.snapshot;
  }
  async open(): Promise<SelectionState> {
    this.baseline = await this.snapshot(); this.baselineSettings = pair(this.settings);
    return new SelectionState(this.baseline, basename(this.cwd) || this.cwd, false, this.projectTrusted, selections => this.save(selections));
  }
  private setTopLevel(settings: SettingsManager, selection: Selection, resource: ResolvedResource): void {
    const scope = selection.scope, base = scope === "global" ? this.agentDir : join(this.cwd, CONFIG_DIR_NAME);
    const inherited = selection.extension.source === "global" && scope === "project";
    const pattern = inherited ? resource.path : slash(relative(base, resource.path));
    const current = (scope === "global" ? settings.getGlobalSettings() : settings.getProjectSettings()).extensions ?? [];
    const inherit = inherited && selection.inherit;
    const updated = current.filter(entry => !(isExact(entry, resource.path, base) && (/^[!+-]/.test(entry) || inherit)));
    if (!inherit) {
      if (inherited && !updated.some(entry => !/^[!+-]/.test(entry) && isExact(entry, resource.path, base))) updated.push(pattern);
      updated.push(`${selection.enabled ? "+" : "-"}${pattern}`);
    }
    if (scope === "global") settings.setExtensionPaths(updated);
    else settings.setProjectExtensionPaths(updated);
  }
  private setPackage(settings: SettingsManager, selection: Selection, resource: ResolvedResource): void {
    const scope = selection.scope;
    const scopeSettings = scope === "global" ? settings.getGlobalSettings() : settings.getProjectSettings();
    const base = scope === "global" ? this.agentDir : join(this.cwd, CONFIG_DIR_NAME);
    const sourceBase = selection.extension.source === "global" ? this.agentDir : join(this.cwd, CONFIG_DIR_NAME);
    const inherited = selection.extension.source === "global" && scope === "project";
    const inherit = inherited && selection.inherit;
    const packages = structuredClone(scopeSettings.packages ?? []);
    let index = packages.findIndex(pkg => samePackage(resource.metadata.source, sourceBase, sourceString(pkg), base));
    if (index < 0) {
      if (inherit) return;
      if (!inherited) throw new Error("The configured package disappeared. Reopen /plugins.");
      const source = /^(?:npm:|git:|https?:|git@)/.test(resource.metadata.source) ? resource.metadata.source : slash(relative(base, localPath(resource.metadata.source, sourceBase))) || ".";
      packages.push({ source, autoload: false }); index = packages.length - 1;
    }
    const original = packages[index], pkg = typeof original === "string" ? { source: original } : { ...original };
    const root = resource.metadata.packageRoot ?? resource.metadata.baseDir;
    if (!root) throw new Error("Package metadata has no resource root. Manage this resource through pi config.");
    const pattern = slash(relative(root, resource.path)), old = pkg.extensions;
    const entries = (old ?? []).filter(entry => slash(target(entry)) !== pattern);
    if (old?.length === 0 && pkg.autoload !== false) entries.push("!**/*");
    if (!inherit) entries.push(`${selection.enabled ? "+" : "-"}${pattern}`);
    pkg.extensions = entries.length ? entries : undefined;
    if (pkg.autoload === false && ![pkg.extensions, pkg.skills, pkg.prompts, pkg.themes].some(value => value !== undefined)) packages.splice(index, 1);
    else packages[index] = pkg;
    if (scope === "global") settings.setPackages(packages);
    else settings.setProjectPackages(packages);
  }
  private verify(before: StateSnapshot, after: StateSnapshot, selections: Selection[]): void {
    const expected = new Map(before.items.map(item => [item.extension.id, { ...item }]));
    for (const selection of selections) {
      const item = expected.get(selection.extension.id);
      if (!item) throw new Error("An extension disappeared. Reopen /plugins.");
      if (selection.scope === "global") item.globalEnabled = selection.enabled;
      else item.projectChoice = selection.inherit ? "inherit" : selection.enabled ? "on" : "off";
    }
    if (expected.size !== after.items.length) throw new Error("Resource discovery changed. Reopen /plugins before applying.");
    for (const item of after.items) {
      const desired = expected.get(item.extension.id);
      const effective = desired?.projectChoice === "inherit" ? desired.globalEnabled : desired?.projectChoice === "on";
      if (!desired || desired.globalEnabled !== item.globalEnabled && item.extension.source === "global" || desired.projectChoice !== item.projectChoice || effective !== item.enabled) {
        throw new Error(`Pi's native configuration could not represent these choices for ${item.extension.name}. Review package filters or broader patterns through pi config, then reopen /plugins.`);
      }
    }
  }
  async save(selections: Selection[]): Promise<SaveResult> {
    return withFileMutationQueue(this.paths.global, () => withFileMutationQueue(this.paths.project, () => this.saveQueued(selections)));
  }
  private async saveQueued(selections: Selection[]): Promise<SaveResult> {
    if (!this.baseline || !this.baselineSettings) throw new Error("Open the manager before saving.");
    let snapshot = this.baseline, error: string | undefined, attempted = false;
    const originalSettings = this.baselineSettings;
    try {
      this.checkCurrent();
      snapshot = await this.snapshot();
      const current = pair(this.settings);
      if (fields(current.global) !== fields(originalSettings.global) || fields(current.project) !== fields(originalSettings.project)) throw new Error("Extension configuration changed externally. Reopen /plugins before saving.");
      if (selections.some(selection => selection.scope === "project") && !this.projectTrusted) throw new Error("Project choices require Pi project trust. Use /trust and reopen /plugins.");
      if (selections.some(selection => selection.scope === "global" && selection.extension.source !== "global" || selection.inherit && selection.extension.source !== "global")) throw new Error("Project-local extensions have no global default.");
      const planned = memorySettings(current, this.projectTrusted);
      for (const selection of selections) {
        const resource = this.resources.get(selection.extension.id);
        if (!resource) throw new Error("An extension disappeared. Reopen /plugins.");
        if (resource.metadata.origin === "package") this.setPackage(planned, selection, resource);
        else this.setTopLevel(planned, selection, resource);
      }
      await planned.flush(); this.checkErrors(planned);
      this.verify(snapshot, (await this.resolveSnapshot(planned)).snapshot, selections);
      this.checkCurrent();
      await this.settings.reload(); this.checkErrors();
      const refreshed = pair(this.settings);
      if (fields(current.global) !== fields(refreshed.global) || fields(current.project) !== fields(refreshed.project)) throw new Error("Extension configuration changed during Apply. Reopen /plugins.");
      this.checkCurrent();
      // Native setters preserve unrelated fields and own file locking/persistence.
      for (const scope of ["global", "project"] as const) {
        const next = scope === "global" ? planned.getGlobalSettings() : planned.getProjectSettings();
        if (JSON.stringify(current[scope].extensions) !== JSON.stringify(next.extensions)) {
          attempted = true;
          if (scope === "global") this.settings.setExtensionPaths(next.extensions ?? []);
          else this.settings.setProjectExtensionPaths(next.extensions ?? []);
        }
        if (JSON.stringify(current[scope].packages) !== JSON.stringify(next.packages)) {
          attempted = true;
          if (scope === "global") this.settings.setPackages(next.packages ?? []);
          else this.settings.setProjectPackages(next.packages ?? []);
        }
      }
      await this.settings.flush(); this.checkErrors();
      const after = await this.snapshot(); this.verify(snapshot, after, selections); snapshot = after;
    } catch (failure) { error = failure instanceof Error ? failure.message : "Saving extension choices failed."; }
    // Read back even after a failure: two native scope files are not one transaction.
    try {
      snapshot = await this.snapshot(); this.baselineSettings = pair(this.settings); this.baseline = snapshot;
    } catch (failure) {
      error = `${error ? error + " " : ""}${failure instanceof Error ? failure.message : "Readback failed."}${attempted ? " Settings may already be saved; reopen /plugins or inspect pi config before retrying." : ""}`;
    }
    const persisted = pair(this.settings);
    const wroteSelections = attempted && (fields(originalSettings.global) !== fields(persisted.global) || fields(originalSettings.project) !== fields(persisted.project));
    return { snapshot, error, wroteSelections: attempted && !!error || wroteSelections };
  }
}
