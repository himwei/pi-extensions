import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Use the actual Pi loader/session lifecycle. Invoke only gate hooks: no command
// execution, real configuration, UAC or network is needed to test cached factories.
const fetchBefore = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("Network disabled for lifecycle regression"); }) as typeof fetch;
const root = await mkdtemp(join(tmpdir(), "pi-package-gate-lifecycle-"));
try {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null,
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false });
  const model = modelRuntime.getModels()[0]; assert.ok(model);
  const path = fileURLToPath(new URL("../permission-gate.ts", import.meta.url));
  let prompts = 0;
  for (let pass = 0; pass < 2; pass++) {
    const settingsManager = SettingsManager.inMemory({ extensions: [path] });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(root);
    const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader,
      modelRuntime, model, sessionManager: manager, sessionStartEvent: { type: "session_start", reason: pass ? "resume" : "startup" } });
    try {
      await session.bindExtensions({ mode: "json" });
      const hook = loader.getExtensions().extensions[0].handlers.get("tool_call")![0];
      const signal = new AbortController().signal;
      const context = session.extensionRunner.createToolContext("lifecycle", signal);
      const invoke = async (approve = false) => hook({ type: "tool_call", toolName: "bash", toolCallId: "lifecycle",
        input: { command: "Remove-Item -LiteralPath .\\fictional-target -Recurse -Force" } }, {
        ...context, hasUI: approve, mode: approve ? "tui" : "json",
        ui: { ...context.ui, custom: async () => { prompts++; return "allowed-session"; } },
      } as any);
      if (pass === 0) {
        assert.equal(await invoke(true), undefined);
        assert.equal(await invoke(), undefined, "same session reuses the grant");
        assert.ok(manager.getEntries().some((entry: any) => entry.customType === "approval-decided" && entry.data.auto));
      } else {
        const result = await invoke();
        assert.ok(result && typeof result === "object" && "block" in result);
        assert.equal(result.block, true, "a cached factory's next session has no old grant");
        assert.equal(manager.getEntries().some((entry: any) => entry.customType === "approval-decided" && entry.data.auto), false);
      }
      assert.equal(prompts, 1);
      assert.equal(manager.getEntries().some((entry: any) => entry.customType === "execution-status"), false);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
      session.dispose();
    }
  }
} finally {
  globalThis.fetch = fetchBefore;
  await rm(root, { recursive: true, force: true });
}
console.log("real Pi cached-factory gate lifecycle passed (no commands executed)");
