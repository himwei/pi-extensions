import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import renameExtension from "../ai-rename.js";
import summaryExtension from "../auto-summary.js";

const root = await mkdtemp(join(tmpdir(), "pi-summary-naming-"));
const model = { provider: "fixture", id: "naming", api: "openai-responses", contextWindow: 65_536,
  maxTokens: 8192 } as Model<any>;
const reply = "# 回复里的小节名\n\n最后回复，保存时保留原文。\n";
const response = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", provider: model.provider, model: model.id, api: model.api,
  content: [{ type: "text", text }], stopReason, timestamp: Date.now(),
  errorMessage: stopReason === "error" ? "fixture failure" : undefined,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
});

async function harness(initialName?: string) {
  const cwd = await mkdtemp(join(root, "case-"));
  const session = SessionManager.inMemory(cwd);
  session.appendMessage({ role: "user", content: "最初任务：修复驱动", timestamp: Date.now() });
  session.appendMessage(response("首条回复：先看日志"));
  session.appendMessage({ role: "user", content: "最近要求：检查编译", timestamp: Date.now() });
  session.appendMessage(response(reply));
  for (const content of ["/n", "/summary 整理"]) {
    session.appendMessage({ role: "user", content, timestamp: Date.now() });
  }
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const events = new Map<string, Array<(event: unknown, ctx: ExtensionCommandContext) => unknown>>();
  const notices: string[] = [];
  const names: string[] = [];
  const calls: Array<{ prompt: string; maxTokens: number; signal: AbortSignal }> = [];
  let name = initialName;
  const state = {
    next: async (_index: number, _signal: AbortSignal): Promise<AssistantMessage> => response("「驱动修复。」"),
    onName: () => {},
  };
  const pi = {
    on(event: string, fn: (event: unknown, ctx: ExtensionCommandContext) => unknown) {
      events.set(event, [...(events.get(event) ?? []), fn]);
    },
    registerCommand(command: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      commands.set(command, options.handler);
    },
    getSessionName: () => name,
    setSessionName(value: string) { state.onName(); name = value; names.push(value); },
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
  } as unknown as ExtensionAPI;
  renameExtension(pi);
  summaryExtension(pi);
  const ctx = {
    mode: "print", cwd, model, sessionManager: session, waitForIdle: async () => {},
    modelRegistry: {
      find: () => model,
      streamSimple(selected: Model<any>, context: any, options: any) {
        assert.equal(selected, model);
        const index = calls.length;
        calls.push({ prompt: context.messages[0].content[0].text, ...options });
        return { result: () => state.next(index, options.signal) };
      },
    },
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  return { cwd, ctx, state, pi, notices, names, calls,
    run: (args = "", command = "summary") => commands.get(command)!(args, ctx),
    emit: (event: string) => (events.get(event) ?? []).map(fn => fn({}, ctx)),
    usage: () => session.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === "extension-usage"
      ? [entry.data as { source: string; outcome: string }] : []),
  };
}

try {
  const named = await harness("保留的会话名");
  await named.run();
  await named.run();
  assert.equal(named.calls.length, 0, "named reply saves make no model request");
  assert.deepEqual(named.names, [], "preserve existing names");
  for (const version of [1, 2]) {
    assert.equal(await readFile(join(named.cwd, `保留的会话名-v${version}.md`), "utf8"), reply);
  }

  const unnamed = await harness();
  unnamed.state.onName = () => assert.ok(readdirSync(unnamed.cwd).includes("驱动修复-v1.md"), "save before naming");
  await unnamed.run();
  await unnamed.run();
  assert.equal(unnamed.calls.length, 1, "reuse the persisted name for subsequent exports");
  assert.equal(unnamed.calls[0].maxTokens, 64);
  assert.equal(await readFile(join(unnamed.cwd, "驱动修复-v1.md"), "utf8"), reply);
  assert.equal(await readFile(join(unnamed.cwd, "驱动修复-v2.md"), "utf8"), reply);
  assert.deepEqual(unnamed.names, ["驱动修复"]);
  assert.deepEqual(unnamed.usage().map(entry => entry.source), ["auto-summary"]);

  const rename = await harness();
  await rename.run("", "n");
  assert.equal(rename.calls[0].prompt, unnamed.calls[0].prompt, "both commands use exactly the same naming input and prompt");
  assert.equal(rename.calls[0].maxTokens, unnamed.calls[0].maxTokens);
  assert.deepEqual(rename.names, ["驱动修复"]);
  assert.deepEqual(rename.usage().map(entry => entry.source), ["ai-rename"]);
  assert.ok(unnamed.calls[0].prompt.includes("最初任务：修复驱动"));
  assert.ok(unnamed.calls[0].prompt.includes("最近要求：检查编译"));
  assert.ok(unnamed.calls[0].prompt.includes("首条回复：先看日志"));
  assert.ok(!unnamed.calls[0].prompt.includes("最后回复，保存时保留原文"));
  assert.ok(!unnamed.calls[0].prompt.includes("/summary 整理"));

  for (const body of ["# 模型另起的名字\n\n整理结果。", "整理结果，没有标题。 "]) {
    const generated = await harness();
    generated.state.next = async index => response(index === 0 ? "驱动修复" : body);
    await generated.run("保留编译细节");
    assert.deepEqual(generated.calls.map(call => call.maxTokens), [64, 8192]);
    assert.equal(generated.calls[0].signal, generated.calls[1].signal, "one cancellation scope covers both requests");
    assert.ok(generated.calls[1].prompt.includes("# 驱动修复"));
    assert.ok(generated.calls[1].prompt.includes("保留编译细节"));
    assert.equal(await readFile(join(generated.cwd, "驱动修复-v1.md"), "utf8"),
      "# 驱动修复\n\n" + (body.startsWith("#") ? "整理结果。" : body.trim()) + "\n");
    assert.deepEqual(generated.names, ["驱动修复"]);
    assert.deepEqual(generated.usage().map(entry => entry.source), ["auto-summary", "auto-summary"]);
  }

  const namedDocument = await harness("既有标题");
  namedDocument.state.next = async () => response("# 别的标题\n\n正文");
  await namedDocument.run("整理");
  assert.equal(namedDocument.calls.length, 1);
  assert.equal(namedDocument.calls[0].maxTokens, model.maxTokens);
  assert.equal(await readFile(join(namedDocument.cwd, "既有标题-v1.md"), "utf8"), "# 既有标题\n\n正文\n");
  assert.deepEqual(namedDocument.names, []);

  const writeFailure = await harness();
  writeFailure.ctx.cwd = join(writeFailure.cwd, "missing");
  await writeFailure.run();
  assert.deepEqual(writeFailure.names, [], "failed writes never name the session");
  assert.ok(writeFailure.notices.some(text => text.startsWith("/summary 失败：")));

  for (const reason of ["error", "aborted", "empty", "document-error"] as const) {
    const failed = await harness();
    failed.state.next = async index => reason === "document-error"
      ? response(index === 0 ? "驱动修复" : "", index === 0 ? "stop" : "error")
      : response(reason === "empty" ? "!!!" : "partial", reason === "empty" ? "stop" : reason);
    await failed.run(reason === "document-error" ? "整理" : "");
    assert.deepEqual(failed.names, [], `${reason} must not name the session`);
    assert.deepEqual(await readdir(failed.cwd), []);
    assert.equal(failed.calls.length, reason === "document-error" ? 2 : 1, "failed calls are never retried");
    assert.equal(failed.usage().length, failed.calls.length, "retain billed failed/aborted replies");
    assert.ok(failed.notices.some(text => text.includes(reason === "aborted" ? "已取消" : "失败")));
  }

  // Hold each phase separately: navigation and reentry remain blocked until the
  // cancelled request settles, including any usage returned on shutdown.
  for (const phase of ["name", "document"] as const) {
    const cancelled = await harness();
    let release!: (message: AssistantMessage) => void;
    let ready!: () => void;
    const pending = new Promise<AssistantMessage>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    cancelled.state.next = async index => {
      if (phase === "document" && index === 0) return response("驱动修复");
      ready();
      return pending;
    };
    const running = cancelled.run(phase === "document" ? "整理" : "");
    await started;
    for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
      assert.ok(cancelled.emit(event).some(result => (result as { cancel?: boolean })?.cancel));
    }
    await cancelled.run();
    assert.equal(cancelled.calls.length, phase === "document" ? 2 : 1);
    cancelled.emit("session_shutdown");
    assert.equal(cancelled.calls.at(-1)!.signal.aborted, true);
    release(response("partial", "aborted"));
    await running;
    assert.deepEqual(await readdir(cancelled.cwd), []);
    assert.deepEqual(cancelled.names, []);
    assert.equal(cancelled.usage().at(-1)?.outcome, "aborted");
    assert.ok(cancelled.emit("session_before_switch").every(result => result === undefined));
  }

  const renamedDuringRequest = await harness();
  renamedDuringRequest.state.next = async () => {
    renamedDuringRequest.pi.setSessionName("后来手动设置的名字");
    return response("驱动修复");
  };
  await renamedDuringRequest.run();
  assert.equal(renamedDuringRequest.pi.getSessionName(), "后来手动设置的名字");
  assert.deepEqual(renamedDuringRequest.names, ["后来手动设置的名字"]);

  const collision = await harness("CON");
  await mkdir(join(collision.cwd, "_CON-v1.md"));
  await collision.run();
  assert.equal(await readFile(join(collision.cwd, "_CON-v2.md"), "utf8"), reply);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("summary naming shares /n input, preserves replies/names, versions saves, and settles cancellation and usage");
