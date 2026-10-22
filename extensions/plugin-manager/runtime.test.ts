import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerPluginManager } from "../plugin-manager.js";
import { ConfigService } from "./config.js";
import { SelectionState } from "./state.js";

const root = await mkdtemp(join(tmpdir(), "pi-plugin-runtime-"));
const agentDir = join(root, "agent"); const cwd = join(root, "project");
const historical = process.env.PI_PLUGIN_MANAGER_TEST_SESSION ?? "";
const original = existsSync(historical) ? await readFile(historical) : undefined;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const builtins = ["read", "bash", "edit", "write"];
const put = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), "utf8");
const fetchBefore = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error("Network access is forbidden in plugin-manager regression tests"); };
try {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "managed.ts"), `
    import { Type } from "typebox";
    export default pi => {
      for (const spec of [{name:"run-script"}, {name:"web_search"}, {name:"web_fetch"},
        {name:"optional_tool", defaultActive:false}, {name:"deferred_tool", exposure:"deferred"}]) {
        pi.registerTool( {...spec, label:spec.name, description:"offline fixture", parameters:Type.Object({}),
          async execute(){ throw new Error("History replay must never execute a tool"); }});
      }
      pi.registerTool({name:"unknown_tool",label:"unknown",description:"no auto contract",parameters:Type.Object({}),
        async execute(){ throw new Error("Must not execute"); }});
    }`, "utf8");
  await writeFile(join(cwd, ".pi", "extensions", "project.ts"), `
    import { Type } from "typebox";
    export default pi => pi.registerTool( {name:"project_tool",label:"project",description:"project fixture",parameters:Type.Object({}),
      async execute(){ throw new Error("Must not execute"); }});`, "utf8");
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  const model = modelRuntime.getModels()[0]; assert.ok(model);
  type Scenario = { name: string; mode?: "auto" | "default"; tools?: string[]; excludeTools?: string[]; noTools?: boolean; defaultTools?: string[]; removed?: boolean; actual?: boolean };
  async function run(scenario: Scenario) {
    await put(join(agentDir, "settings.json"), scenario.defaultTools ? { defaultTools: scenario.defaultTools } : {});
    await put(join(agentDir, "plugin-manager.json"), { version: 1, mode: scenario.mode ?? "auto", saveTarget: "project" });
    let manager: SessionManager;
    if (scenario.actual && original) {
      const copy = join(root, `${scenario.name}.jsonl`); await copyFile(historical, copy);
      manager = SessionManager.open(copy, root, cwd);
    } else {
      manager = SessionManager.inMemory(cwd);
      manager.appendMessage({ role: "system", content: "historical four-tool fixture", timestamp: Date.now(),
        toolsAdded: builtins.map(name => ({ name, description: name, parameters: Type.Object({}) })) });
    }
    if (scenario.removed) manager.appendMessage({ role: "system", content: "deliberate tool removal", timestamp: Date.now(), toolsRemoved: [{ name: "run-script" }] });
    const settingsManager = SettingsManager.inMemory(scenario.defaultTools ? { defaultTools: scenario.defaultTools } : {}, { projectTrusted: true });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [{ name: "manager-under-test", factory: pi => registerPluginManager(pi, { agentDir }) }] });
    await loader.reload();
    assert.equal(loader.getExtensions().errors.length, 0, "fixtures and manager must load without errors");
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, sessionManager: manager, settingsManager, resourceLoader: loader,
      tools: scenario.tools, excludeTools: scenario.excludeTools, noTools: scenario.noTools ? "all" : undefined,
      sessionStartEvent: { type: "session_start", reason: "resume" } });
    const before = session.getActiveToolNames();
    const errors: string[] = [];
    try {
      await session.bindExtensions({ mode: "json", onError: error => errors.push(String(error.error)) });
      const after = session.getActiveToolNames();
      assert.deepEqual(errors, [], `${scenario.name}: no extension errors`);
      const audit = manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "plugin-manager-tools");
      const delta = after.filter(name => !before.includes(name));
      assert.deepEqual(delta, [], scenario.name + ": manager never activates tools");
      assert.equal(audit.length, 0, scenario.name + ": manager writes no activation audit");
      assert.equal(after.includes("run-script"), !scenario.noTools && !scenario.removed && !scenario.tools?.includes("-run-script") &&
        !scenario.excludeTools?.includes("run-script") && !scenario.tools?.includes("read"), scenario.name);
      assert.equal(after.includes("optional_tool"), false, scenario.name + ": opt-in stays inactive");
      const activeBeforeStatus = [...after];
      const command = session.extensionRunner.getRegisteredCommands().find(command => command.name === "plugins"); assert.ok(command);
      await command.handler("status", session.extensionRunner.createCommandContext());
      assert.deepEqual(session.getActiveToolNames(), activeBeforeStatus, "status is read-only");
      if (scenario.name === "auto") {
        await session.reload();
        assert.ok(session.getActiveToolNames().includes("run-script"));
        assert.equal(session.getActiveToolNames().includes("optional_tool"), false);
      }
      console.log(`plugin-manager ${scenario.name}: ${before.join(",")} -> ${after.join(",")}`);
      return after;
    } finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  }
  await run({ name: "default", mode: "default" });
  await run({ name: "auto" });
  await run({ name: "explicit-minus", tools: ["-run-script"] });
  await run({ name: "excluded", excludeTools: ["run-script"] });
  await run({ name: "allowlist", tools: ["read", "bash"] });
  await run({ name: "no-tools", noTools: true });
  await run({ name: "default-tools", defaultTools: builtins });
  await run({ name: "historically-removed", removed: true });
  if (original) {
    const before = await run({ name: "actual-old-default", actual: true, mode: "default" });
    const after = await run({ name: "actual-old-auto", actual: true });
    for (const tool of before) assert.ok(after.includes(tool), `preserve historical ${tool}`);
    for (const tool of ["run-script", "web_search", "web_fetch"]) assert.ok(after.includes(tool));
    assert.equal(digest(await readFile(historical)), digest(original), "the original session must remain byte-for-byte unchanged");
    console.log("Actual historical session copy passed; original SHA-256 unchanged.");
  } else console.log("No optional session supplied; historical fixtures covered instead.");
  {
    // Load the shipped wrappers with isolated config/auth and a synthetic old declaration.
    const realAgent = join(root, "real-agent"); const realCwd = join(root, "real-project");
    await mkdir(realAgent, { recursive: true }); await mkdir(realCwd, { recursive: true });
    const entries = ["web-search.ts", "powershell-bash.ts", "write-transforms.ts", "permission-gate.ts"].map(name => fileURLToPath(new URL(`../${name}`, import.meta.url)));
    await put(join(realAgent, "settings.json"), { extensions: entries });
    await put(join(realAgent, "plugin-manager.json"), { version: 1, mode: "auto", saveTarget: "project" });
    const realSettings = SettingsManager.inMemory({ extensions: entries }, { projectTrusted: true });
    const realLoader = new DefaultResourceLoader({ cwd: realCwd, agentDir: realAgent, settingsManager: realSettings,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [{ name: "manager", factory: pi => registerPluginManager(pi, { agentDir: realAgent }) }] });
    await realLoader.reload(); assert.deepEqual(realLoader.getExtensions().errors, []);
    const realManager = SessionManager.inMemory(realCwd);
    realManager.appendMessage({ role: "system", content: "historical four-tool fixture", timestamp: Date.now(),
      toolsAdded: builtins.map(name => ({ name, description: name, parameters: Type.Object({}) })) });
    const { session } = await createAgentSession({ cwd: realCwd, agentDir: realAgent, settingsManager: realSettings,
      modelRuntime, model, sessionManager: realManager, resourceLoader: realLoader });
    const errors: unknown[] = [];
    try {
      await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
      assert.deepEqual(errors, []);
      const active = session.getActiveToolNames();
      for (const name of [...builtins, "web_search", "web_fetch"]) assert.ok(active.includes(name), `real wrappers: ${name}`);
      assert.equal(active.includes("powershell"), false, "the real native PowerShell wrapper remains opt-in");
      const read = session.resourceLoader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === "read");
      assert.ok(read, "the real guarded read wrapper remains registered");
      assert.ok(session.extensionRunner.hasHandlers("tool_call"), "permission hooks remain installed");
      console.log(`Synthetic old declaration with shipped wrappers: ${active.join(",")}; powershell remains opt-in, permission/read hooks retained.`);
    } finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  }

  // A late inventory load must not notify or open UI after shutdown.
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  let command: any, notices = 0, activations = 0;
  const mock = { on(name: string, handler: any) { handlers.set(name, handler); },
    registerCommand(_name: string, definition: any) { command = definition; },
    getActiveTools: () => [], setActiveTools() { activations++; } } as unknown as ExtensionAPI;
  registerPluginManager(mock, { agentDir });
  const originalOpen = ConfigService.prototype.open;
  let release!: (value: SelectionState) => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  ConfigService.prototype.open = function () { started(); return new Promise(resolve => { release = resolve; }); };
  try {
    const ctx = { cwd, mode: "json", waitForIdle: async () => {}, isProjectTrusted: () => true, ui: { notify() { notices++; } } };
    handlers.get("session_start")!({}, ctx);
    const waiting = command.handler("status", ctx); await began;
    handlers.get("session_shutdown")!({}, ctx);
    release(new SelectionState({ items: [] }, "fixture")); await waiting;
    assert.equal(notices, 0); assert.equal(activations, 0);
  } finally { ConfigService.prototype.open = originalOpen; }

} finally {
  globalThis.fetch = fetchBefore;
  assert.equal(networkRequests, 0, "old-session replay and discovery must issue no network requests");
  if (original) assert.equal(digest(await readFile(historical)), digest(original));
  await rm(root, { recursive: true, force: true });
}
