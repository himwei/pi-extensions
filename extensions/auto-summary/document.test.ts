import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import summaryExtension from "../auto-summary.js";

const cwd = await mkdtemp(join(tmpdir(), "pi-summary-document-"));
try {
  for (const scenario of [
    { name: "large-output", maxTokens: 32_768, conversation: "Keep this conversation." },
    { name: "small-output", maxTokens: 2048, conversation: "Keep this conversation." },
    { name: "full-window-output", maxTokens: 65_536, conversation: "中".repeat(20_000) },
    { name: "bounded-input", maxTokens: 32_768, conversation: "CONTEXT-START\n" + "中".repeat(60_000) + "\nCONTEXT-END" },
  ]) {
    const model = { provider: "fixture", id: "summary", api: "openai-responses", contextWindow: 65_536,
      maxTokens: scenario.maxTokens } as Model<any>;
    const session = SessionManager.inMemory(cwd);
    session.appendMessage({ role: "user", content: scenario.conversation, timestamp: Date.now() });
    const markdown = `# ${scenario.name}\n\nSaved document.\n`;
    const notices: string[] = [];
    let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    let calls = 0;
    summaryExtension({
      on() {},
      getSessionName: () => scenario.name,
      setSessionName: () => { throw new Error("existing session names must be preserved"); },
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    } as unknown as ExtensionAPI);
    const ctx = {
      mode: "print", cwd, model, sessionManager: session, waitForIdle: async () => {},
      modelRegistry: {
        find: () => model,
        streamSimple(selected: Model<any>, context: any, options: any) {
          calls++;
          assert.equal(selected, model);
          assert.equal(options.maxTokens, scenario.maxTokens, "use the model allowance, including values above 16,384");
          assert.ok(options.signal instanceof AbortSignal);
          const prompt = context.messages[0].content[0].text as string;
          assert.ok(prompt.includes("Preserve the examples."));
          if (scenario.name === "bounded-input") {
            assert.ok(prompt.includes("CONTEXT-START") && prompt.includes("CONTEXT-END"));
            assert.ok(prompt.includes("[较早的会话内容因文档生成请求的上下文限制已截断]"));
            assert.ok(prompt.length < scenario.conversation.length);
          } else assert.ok(prompt.includes(scenario.conversation));
          return { result: async (): Promise<AssistantMessage> => ({
            role: "assistant", provider: model.provider, model: model.id, api: model.api,
            content: [{ type: "text", text: markdown }], stopReason: "stop", timestamp: Date.now(),
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
              cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
          }) };
        },
      },
      ui: { notify: (message: string) => notices.push(message) },
    } as unknown as ExtensionCommandContext;
    await handler("Preserve the examples.", ctx);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(cwd, `${scenario.name}-v1.md`), "utf8"), markdown);
    assert.ok(notices.some(message => message.startsWith("已生成完整 Markdown 文档：")));
    assert.equal(notices.some(message => message.includes("超过生成输入预算")), scenario.name === "bounded-input");
    const usage = session.getEntries().filter(entry => entry.type === "custom" && entry.customType === "extension-usage");
    assert.equal(usage.length, 1, "record the auxiliary request exactly once");
  }
} finally { await rm(cwd, { recursive: true, force: true }); }
console.log("summary documents use model output limits, preserve bounded context, and save with one usage record");
