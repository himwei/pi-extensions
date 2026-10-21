import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager, withFileMutationQueue, type ExtensionAPI, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import { readToolContracts } from "../shared/managed-tools.js";
import { SelectionState, type InventoryItem, type Preferences, type Selection, type SettingsPaths, type StateSnapshot } from "./state.js";

type NativeSettings = ReturnType<SettingsManager["getGlobalSettings"]>;
type Package = NonNullable<NativeSettings["packages"]>[number];
const defaults: Preferences = { mode: "default", saveTarget: "project" };
const slash = (path: string) => path.replace(/\\/g, "/");
export function pathKey(path: string): string {
  let canonical = resolve(path);
  try { canonical = realpathSync.native(canonical); } catch { /* Missing configured paths keep their stable lexical identity. */ }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
function localPath(path: string, base: string) { return resolve(base, path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path); }
function samePreferences(left: Preferences, right: Preferences) { return left.mode === right.mode && left.saveTarget === right.saveTarget; }
function preferenceValue(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin-manager.json object.");
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) throw new Error("Unsupported plugin-manager.json version.");
  if (record.mode !== undefined && record.mode !== "default" && record.mode !== "auto") throw new Error("Invalid plugin-manager mode.");
  if (record.saveTarget !== undefined && record.saveTarget !== "global" && record.saveTarget !== "project") throw new Error("Invalid plugin-manager save destination.");
  return { mode: record.mode as Preferences["mode"] ?? defaults.mode, saveTarget: record.saveTarget as Preferences["saveTarget"] ?? defaults.saveTarget };
}
async function preferenceRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const bytes = await readFile(path);
    const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    preferenceValue(record);
    return record as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}. Repair the preferences file before saving.`);
  }
}
export async function readPreferences(path: string): Promise<Preferences> { return preferenceValue(await preferenceRecord(path)); }
export async function savePreferences(path: string, next: Preferences, expected: Preferences): Promise<void> {
  await withFileMutationQueue(path, async () => {
    const current = await preferenceRecord(path);
    if (!samePreferences(preferenceValue(current), expected)) throw new Error("Plugin-manager settings changed externally. Reopen /plugins before saving.");
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, JSON.stringify({ ...current, version: 1, ...next }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  });
}
function memorySettings(global: NativeSettings, projectTrusted = false): SettingsManager {
  return SettingsManager.fromStorage({ withLock(scope, fn) { fn(JSON.stringify(scope === "global" ? global : {})); } }, { projectTrusted });
}
function isManaged(resource: ResolvedResource) { return !resource.path.startsWith("builtin:") && resource.metadata.scope !== "temporary"; }
const target = (entry: string) => /^[!+-]/.test(entry) ? entry.slice(1) : entry;
function isExact(entry: string, path: string, base: string) {
  return !/[*?{}]/.test(target(entry)) && pathKey(localPath(target(entry), base)) === pathKey(path);
}
function sourceString(pkg: Package) { return typeof pkg === "string" ? pkg : pkg.source; }
function samePackage(left: string, leftBase: string, right: string, rightBase: string): boolean {
  if (/^(?:npm:|git:|https?:|git@)/.test(left) || /^(?:npm:|git:|https?:|git@)/.test(right)) return left === right;
  return pathKey(localPath(left, leftBase)) === pathKey(localPath(right, rightBase));
}

export class ConfigService {
  readonly paths: SettingsPaths;
  private settings: SettingsManager;
  private resources = new Map<string, ResolvedResource>();
  private baseline?: StateSnapshot;
  constructor(readonly cwd: string, readonly agentDir: string, readonly projectTrusted: boolean,
    private pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "events">) {
    this.paths = { global: join(agentDir, "settings.json"), project: join(cwd, CONFIG_DIR_NAME, "settings.json"), preferences: join(agentDir, "plugin-manager.json") };
    this.settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  }
  private checkErrors() {
    const errors = this.settings.drainErrors();
    if (errors.length) throw new Error(`Cannot read ${errors.map(error => error.path ?? `${error.scope} settings`).join(", ")}. Repair Pi settings before saving.`);
  }
  async snapshot(): Promise<StateSnapshot> {
    await this.settings.reload(); this.checkErrors();
    const globalSettings = this.settings.getGlobalSettings();
    const resolveResources = (settingsManager: SettingsManager) => new DefaultPackageManager({ cwd: this.cwd, agentDir: this.agentDir, settingsManager }).resolve(async () => "skip");
    // Resolution is read-only: missing packages are always skipped, never installed or refreshed.
    const [inherited, effective, preferences] = await Promise.all([
      resolveResources(memorySettings(globalSettings)), resolveResources(this.settings), readPreferences(this.paths.preferences),
    ]);
    const globals = new Map(inherited.extensions.filter(isManaged).map(resource => [pathKey(resource.path), resource]));
    const combined = new Map(effective.extensions.filter(isManaged).map(resource => [pathKey(resource.path), resource]));
    const tools = this.pi.getAllTools();
    const contracts = readToolContracts(this.pi);
    this.resources.clear();
    const items: InventoryItem[] = [];
    for (const [id, resource] of new Map([...globals, ...combined])) {
      const global = globals.get(id);
      const current = combined.get(id) ?? global!;
      const owner = global ?? resource;
      this.resources.set(id, owner);
      const registered = tools.filter(tool => !tool.sourceInfo.path.startsWith("builtin:") && pathKey(tool.sourceInfo.path) === id);
      const source = global ? "global" : "project";
      items.push({ extension: { id, name: basename(owner.path), source, path: owner.path,
        description: "Selection applies after /reload. Tool metadata describes the currently registered runtime.",
        tools: registered.map(tool => ({ name: tool.name, exposure: tool.exposure, sourcePath: tool.sourceInfo.path,
          auto: contracts.get(tool.name)?.defaultActive === true && ["direct", "model-only"].includes(tool.exposure) })) },
        globalEnabled: global?.enabled ?? true,
        ...(source === "project" || current.metadata.scope === "project" ? { projectOverride: current.enabled } : {}), enabled: current.enabled });
    }
    items.sort((left, right) => left.extension.source.localeCompare(right.extension.source) || left.extension.name.localeCompare(right.extension.name));
    return { items, preferences };
  }
  async open(): Promise<PersistentState> {
    const snapshot = await this.snapshot(); this.baseline = snapshot;
    return new PersistentState(this, snapshot, this.pi.getActiveTools());
  }
  private setTopLevel(selection: Selection, resource: ResolvedResource, saveTarget: Preferences["saveTarget"], globalEnabled: boolean) {
    const base = saveTarget === "global" ? this.agentDir : join(this.cwd, CONFIG_DIR_NAME);
    const inherited = selection.extension.source === "global" && saveTarget === "project";
    const pattern = inherited ? resource.path : slash(relative(base, resource.path));
    const current = saveTarget === "global" ? this.settings.getGlobalSettings().extensions ?? [] : this.settings.getProjectSettings().extensions ?? [];
    const inherit = inherited && (selection.inherit || selection.enabled === globalEnabled);
    const updated = current.filter(entry => !(isExact(entry, resource.path, base) && (/^[!+-]/.test(entry) || inherit)));
    if (!inherit) {
      if (inherited && !updated.some(entry => !/^[!+-]/.test(entry) && isExact(entry, resource.path, base))) updated.push(pattern);
      updated.push(`${selection.enabled ? "+" : "-"}${pattern}`);
    }
    if (saveTarget === "global") this.settings.setExtensionPaths(updated);
    else this.settings.setProjectExtensionPaths(updated);
  }
  private setPackage(selection: Selection, resource: ResolvedResource, saveTarget: Preferences["saveTarget"], globalEnabled: boolean) {
    const scopeSettings = saveTarget === "global" ? this.settings.getGlobalSettings() : this.settings.getProjectSettings();
    const base = saveTarget === "global" ? this.agentDir : join(this.cwd, CONFIG_DIR_NAME);
    const sourceBase = selection.extension.source === "global" ? this.agentDir : join(this.cwd, CONFIG_DIR_NAME);
    const inherited = selection.extension.source === "global" && saveTarget === "project";
    const inherit = inherited && (selection.inherit || selection.enabled === globalEnabled);
    const packages = structuredClone(scopeSettings.packages ?? []);
    let index = packages.findIndex(pkg => samePackage(resource.metadata.source, sourceBase, sourceString(pkg), base));
    if (index < 0) {
      if (inherit) return;
      if (!inherited) throw new Error("The configured package disappeared. Reopen /plugins.");
      const source = /^(?:npm:|git:|https?:|git@)/.test(resource.metadata.source) ? resource.metadata.source :
        slash(relative(base, localPath(resource.metadata.source, sourceBase))) || ".";
      packages.push({ source, autoload: false }); index = packages.length - 1;
    }
    const original = packages[index];
    const pkg = typeof original === "string" ? { source: original } : { ...original };
    const root = resource.metadata.packageRoot ?? resource.metadata.baseDir;
    if (!root) throw new Error("Package metadata has no resource root. Use pi config for this entry.");
    const pattern = slash(relative(root, resource.path));
    const old = pkg.extensions;
    let entries = (old ?? []).filter(entry => slash(target(entry)) !== pattern);
    // An empty explicit package filter disables all extensions; preserve that baseline.
    if (old?.length === 0 && pkg.autoload !== false) entries.push("!**/*");
    if (!inherit) entries.push(`${selection.enabled ? "+" : "-"}${pattern}`);
    pkg.extensions = entries.length ? entries : undefined;
    if (pkg.autoload === false && ![pkg.extensions, pkg.skills, pkg.prompts, pkg.themes].some(value => value !== undefined)) packages.splice(index, 1);
    else packages[index] = pkg;
    if (saveTarget === "global") this.settings.setPackages(packages);
    else this.settings.setProjectPackages(packages);
  }
  async save(selections: Selection[], preferences: Preferences): Promise<{ snapshot: StateSnapshot; error?: string; wroteSelections: boolean }> {
    if (!this.baseline) throw new Error("Open the manager before saving.");
    let wroteSelections = false;
    let error: string | undefined;
    const previous = this.baseline;
    try {
      const latest = await this.snapshot();
      if (!samePreferences(latest.preferences, previous.preferences)) throw new Error("Manager settings changed externally. Reopen /plugins.");
      const applicable = selections.filter(selection => preferences.saveTarget === "project" || selection.extension.source === "global");
      if (applicable.length && preferences.saveTarget === "project" && !this.projectTrusted) throw new Error("Project settings require Pi project trust. Choose Global or trust the project and reopen /plugins.");
      for (const selection of applicable) {
        const before = previous.items.find(item => item.extension.id === selection.extension.id);
        const now = latest.items.find(item => item.extension.id === selection.extension.id);
        if (!before || !now || before.enabled !== now.enabled || before.globalEnabled !== now.globalEnabled || before.projectOverride !== now.projectOverride) {
          throw new Error("Extension selections changed externally. Reopen /plugins before saving.");
        }
      }
      for (const selection of applicable) {
        const resource = this.resources.get(selection.extension.id)!;
        const globalEnabled = latest.items.find(item => item.extension.id === selection.extension.id)!.globalEnabled;
        if (resource.metadata.origin === "package") this.setPackage(selection, resource, preferences.saveTarget, globalEnabled);
        else this.setTopLevel(selection, resource, preferences.saveTarget, globalEnabled);
      }
      await this.settings.flush(); this.checkErrors();
      wroteSelections = applicable.length > 0;
      if (!samePreferences(preferences, latest.preferences)) await savePreferences(this.paths.preferences, preferences, latest.preferences);
    } catch (failure) { error = failure instanceof Error ? failure.message : "Saving extension settings failed."; }
    const snapshot = await this.snapshot(); this.baseline = snapshot;
    wroteSelections ||= selections.some(selection => {
      const before = previous.items.find(item => item.extension.id === selection.extension.id);
      const after = snapshot.items.find(item => item.extension.id === selection.extension.id);
      return !!before && !!after && (before.enabled !== after.enabled || before.globalEnabled !== after.globalEnabled || before.projectOverride !== after.projectOverride);
    });
    return { snapshot, error, wroteSelections };
  }
}

class PersistentState extends SelectionState {
  constructor(private service: ConfigService, snapshot: StateSnapshot, activeTools: string[]) {
    super(snapshot, service.paths, basename(service.cwd) || service.cwd);
    this.activeTools = activeTools;
  }
  override async save(): Promise<number> {
    const result = await this.service.save(this.selections, this.preferences);
    this.rebase(result.snapshot, true);
    this.reloadRequired ||= result.wroteSelections;
    if (result.error) throw new Error(result.error);
    return this.changes.length;
  }
}
