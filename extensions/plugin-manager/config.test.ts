import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConfigService } from "./config.js";

const root = await mkdtemp(join(tmpdir(), "pi-plugin-config-"));
const agentDir = join(root, "agent"), cwd = join(root, "project");
const globalPath = join(agentDir, "settings.json"), projectPath = join(cwd, ".pi", "settings.json");
const preferencesPath = join(agentDir, "plugin-manager.json");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const put = async (path: string, value: unknown) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value), "utf8"); };
const service = (trusted = true, current = () => true) => new ConfigService(cwd, agentDir, trusted, current);
try {
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  for (const name of ["foo", "bar"]) await writeFile(join(agentDir, "extensions", `${name}.ts`), "export default () => {};", "utf8");
  await writeFile(join(cwd, ".pi", "extensions", "local.ts"), "export default () => {};", "utf8");
  await put(globalPath, { theme: "dark", unrelated: { keep: true }, extensions: ["-extensions/foo.ts"] });
  await put(projectPath, { customProject: 7 });
  let state = await service().open();
  const named = (name: string) => { const entry = state.extensions.find(extension => extension.name === `${name}.ts`); assert.ok(entry, name); return entry; };
  assert.equal(state.effective(named("foo")), false);
  assert.equal(named("local").source, "project");
  await assert.rejects(readFile(preferencesPath), { code: "ENOENT" });
  state.toggle(named("foo"), "global"); await state.apply();
  assert.equal((await json(globalPath)).unrelated.keep, true); assert.equal((await json(projectPath)).customProject, 7);
  assert.equal(state.effective(named("foo")), true);

  state = await service().open(); state.toggle(named("bar"), "project"); await state.apply();
  assert.equal(state.selection(named("bar")).choice, "off"); assert.equal(state.effective(named("bar")), false);
  state.inherit(named("bar")); await state.apply();
  assert.equal(state.selection(named("bar")).choice, "inherit");
  assert.equal((await json(projectPath)).extensions.some((entry: string) => entry.includes("bar.ts")), false);

  // Explicit choices that match Global stay explicit when Global later changes.
  state.toggle(named("bar"), "project"); state.toggle(named("bar"), "project"); await state.apply();
  assert.equal(state.selection(named("bar")).choice, "on");
  state.toggle(named("bar"), "global"); await state.apply();
  assert.equal(state.selection(named("bar")).enabled, false); assert.equal(state.effective(named("bar")), true);
  state.inherit(named("bar")); await state.apply(); assert.equal(state.effective(named("bar")), false);
  state.toggle(named("foo"), "global"); state.toggle(named("local"), "project"); await state.apply();
  assert.equal(state.count(), 0); assert.equal(state.selection(named("local")).choice, "off");
  assert.equal(state.toggle(named("local"), "global"), false); assert.equal(state.inherit(named("local")), false);

  // Obsolete preferences are ignored, even when malformed, and never rewritten.
  await writeFile(preferencesPath, "{obsolete broken preferences", "utf8");
  state = await service().open(); state.toggle(named("foo"), "global");
  await put(globalPath, { ...(await json(globalPath)), theme: "light" });
  await state.apply(); assert.equal((await json(globalPath)).theme, "light");
  assert.equal(await readFile(preferencesPath, "utf8"), "{obsolete broken preferences");
  state = await service().open(); state.toggle(named("bar"), "project");
  await put(globalPath, { ...(await json(globalPath)), extensions: [...(await json(globalPath)).extensions, "+extensions/bar.ts"] });
  await assert.rejects(state.apply(), /changed externally/);

  state = await service(false).open();
  const projectBefore = await readFile(projectPath, "utf8");
  assert.equal(state.toggle(named("foo"), "project"), false);
  state.toggle(named("foo"), "global"); await state.apply();
  assert.equal(await readFile(projectPath, "utf8"), projectBefore);
  let current = true;
  state = await service(true, () => current).open(); state.toggle(named("foo"), "global");
  const globalBefore = await readFile(globalPath, "utf8"); current = false;
  await assert.rejects(state.apply(), /old runtime/); assert.equal(await readFile(globalPath, "utf8"), globalBefore);

  // A failure in the second native file preserves saved cells and pending drafts.
  await put(globalPath, {}); await put(projectPath, {});
  state = await service().open(); state.toggle(named("foo"), "global"); state.toggle(named("local"), "project");
  const originalProjectSetter = SettingsManager.prototype.setProjectExtensionPaths;
  let projectSets = 0;
  SettingsManager.prototype.setProjectExtensionPaths = function (paths) {
    // The first call validates the memory proposal; the second is the real save.
    if (++projectSets === 2) throw new Error("Simulated project save failure");
    originalProjectSetter.call(this, paths);
  };
  try { await assert.rejects(state.apply(), /Simulated project save failure/); }
  finally { SettingsManager.prototype.setProjectExtensionPaths = originalProjectSetter; }
  assert.equal(state.count("global"), 0); assert.equal(state.count("project"), 1);
  assert.equal(state.reloadRequired, true); assert.equal(state.effective(named("foo")), false);
  await state.apply(); assert.equal(state.count(), 0); assert.equal(state.selection(named("local")).choice, "off");

  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await put(join(packageRoot, "package.json"), { name: "fixture", pi: { extensions: ["./extensions"] } });
  for (const name of ["one", "two"]) await writeFile(join(packageRoot, "extensions", `${name}.ts`), "export default () => {};", "utf8");
  await put(globalPath, { packages: [relative(agentDir, packageRoot)] }); await put(projectPath, { customProject: 7 });
  state = await service().open(); state.toggle(named("one"), "global"); await state.apply();
  assert.equal(state.effective(named("one")), false); assert.equal(state.effective(named("two")), true);
  state.toggle(named("two"), "project"); await state.apply();
  assert.equal(state.effective(named("two")), false); assert.equal((await json(projectPath)).packages[0].autoload, false);
  state.inherit(named("two")); await state.apply();
  assert.equal(state.effective(named("two")), true); assert.equal((await json(projectPath)).packages.length, 0);
  state.toggle(named("two"), "project"); state.toggle(named("two"), "project"); await state.apply();
  assert.equal(state.selection(named("two")).choice, "on");
  await put(globalPath, { packages: [{ source: relative(agentDir, packageRoot), extensions: [] }] }); await put(projectPath, {});
  state = await service().open(); state.toggle(named("one"), "global"); await state.apply();
  assert.equal(state.effective(named("one")), true); assert.equal(state.effective(named("two")), false);

  // Pi ignores filters for a package source that is a single file: fail before writing.
  await put(globalPath, { packages: [relative(agentDir, join(packageRoot, "extensions", "one.ts"))] });
  state = await service().open(); state.toggle(named("one"), "global");
  const unsupportedBefore = await readFile(globalPath, "utf8");
  await assert.rejects(state.apply(), /native configuration/); assert.equal(await readFile(globalPath, "utf8"), unsupportedBefore);
  await writeFile(globalPath, "{broken", "utf8");
  await assert.rejects(service().open(), /Repair Pi settings/); assert.equal(await readFile(globalPath, "utf8"), "{broken");
  console.log("plugin-manager: native discovery, two-scope saves, explicit inheritance, package deltas, stale runtime and configuration checks passed");
} finally { await rm(root, { recursive: true, force: true }); }
