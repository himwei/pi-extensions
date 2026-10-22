import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CURSOR_MARKER, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { getAgentDir, withFileMutationQueue, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { SearchClient } from "./client.js";
import { commandRequest } from "./command-ui.js";
import { credentialsFor, readConfigEnvFile, type CredentialReader } from "./configuration.js";
import { orderedProviders } from "./registry.js";
import { ApiError } from "./response.js";

/** Native editing/paste behavior, but the native plaintext renderer is never called. */
export class MaskedKeyInput {
  focused = true;
  private input = new Input();
  private settled = false;
  constructor(private theme: Pick<Theme, "fg">, private label: string, private done: (key: string | undefined) => void) {
    this.input.onSubmit = key => this.finish(key.trim() || undefined);
    this.input.onEscape = () => this.finish(undefined);
  }
  private finish(key: string | undefined) {
    if (this.settled) return;
    this.settled = true;
    this.input.setValue("");
    this.done(key);
  }
  render(width: number): string[] {
    const count = Math.min(this.input.getValue().length, Math.max(0, width - 8));
    return [truncateToWidth(this.label, width),
      this.theme.fg("accent", "> " + "*".repeat(count)) + (this.focused ? CURSOR_MARKER : ""),
      truncateToWidth("Enter 保存 / Esc 取消；密钥不显示、不写入对话", width)];
  }
  handleInput(data: string) {
    if (this.settled) return;
    if (matchesKey(data, "escape")) { this.finish(undefined); return; }
    if (data.length > 16_384) return;
    this.input.handleInput(data);
  }
  invalidate() {}
  cancel() { this.finish(undefined); }
  dispose() { this.input.setValue(""); this.settled = true; }
}

export async function maskedKey(ctx: ExtensionCommandContext, label: string, signal: AbortSignal): Promise<string | undefined> {
  if (ctx.mode !== "tui") throw new ApiError(400, "密钥输入仅在 Pi 交互终端中提供；不会回退到明文输入或 RPC");
  signal.throwIfAborted();
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const input = new MaskedKeyInput(theme, label, done);
    const cancel = () => input.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    return {
      get focused() { return input.focused; }, set focused(value: boolean) { input.focused = value; },
      render: (width: number) => input.render(width), invalidate() {},
      handleInput(data: string) { input.handleInput(data); tui.requestRender(); },
      dispose() { signal.removeEventListener("abort", cancel); input.dispose(); },
    };
  });
}

export class SearchSettings {
  readonly path: string;
  constructor(private options: { path?: string; readConfig?: () => Record<string, string>; readCredential?: CredentialReader; fetchImpl?: typeof fetch } = {}) {
    this.path = options.path ?? join(getAgentDir(), "config", "pi-extensions", ".env.web-search");
  }
  readConfig() { return (this.options.readConfig ?? readConfigEnvFile)(); }
  snapshot(): string | null {
    try {
      if (!lstatSync(this.path).isFile()) throw new Error("not a regular file");
      return readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ApiError(500, "无法安全读取搜索配置，未作修改");
    }
  }
  credentialStatus(): string[] {
    const file = this.readConfig();
    return orderedProviders().map(adapter => {
      const credential = credentialsFor(adapter, file, this.options.readCredential);
      return `${adapter.label}：${credential.apiKey ? "已配置" : "未配置"}${credential.source === "auth.json" ? "（Pi 凭据）" : ""}`;
    });
  }
  selectionExplanation(client: SearchClient): string {
    const label = orderedProviders().find(adapter => adapter.id === client.provider)?.label ?? client.provider;
    switch (client.selectionReasonCode) {
      case "explicit": return `已手动指定 ${label}`;
      case "preferred": return `已配置 ${label} 凭据，按优先级优先使用`;
      case "fallback": return `未配置更高优先级渠道的凭据，使用已配置的 ${label}`;
      case "missing": return "尚未配置搜索凭据，请运行 /websearch setup";
    }
  }
  async save(patch: Record<string, string>, expected: string | null, signal: AbortSignal, apply: (client: SearchClient) => void): Promise<void> {
    await withFileMutationQueue(this.path, async () => {
      signal.throwIfAborted();
      if (this.snapshot() !== expected) throw new ApiError(409, "配置已被其他操作修改，请重新打开设置，未覆盖现有配置");
      const allowed = new Set(["provider", ...orderedProviders().flatMap(adapter => [...adapter.credentials.keyFields, ...adapter.credentials.baseUrlFields])]);
      for (const [key, value] of Object.entries(patch)) {
        if (!allowed.has(key) || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || (key !== "provider" && /\s/.test(value))) throw new ApiError(400, "配置值无效，未保存");
      }
      const candidate = new SearchClient({ readEnvFile: () => ({ ...this.readConfig(), ...patch }), readCredential: this.options.readCredential,
        fetchImpl: this.options.fetchImpl });
      const lines = (expected ?? "").split(/\r?\n/).filter(line => {
        const match = /^\s*([^#\s=]+)\s*=/.exec(line);
        return !match || !Object.hasOwn(patch, match[1]);
      });
      const text = lines.join("\n").trimEnd() + "\n" + Object.entries(patch).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
      const temporary = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
        signal.throwIfAborted();
        if (this.snapshot() !== expected) throw new ApiError(409, "搜索配置已变化，未覆盖现有配置");
        renameSync(temporary, this.path);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        signal.throwIfAborted();
        throw new ApiError(500, "搜索配置保存失败，未显示密钥；请检查个人配置目录权限");
      } finally { try { unlinkSync(temporary); } catch { /* renamed or never created */ } }
      apply(candidate);
    });
  }
  async command(
    command: "setup" | "provider", argument: string | undefined, ctx: ExtensionCommandContext,
    signal: AbortSignal, client: SearchClient, apply: (client: SearchClient) => void,
  ): Promise<void> {
    if (ctx.mode !== "tui" && (command === "setup" || !argument)) {
      ctx.ui.notify("请在 Pi 交互终端运行 /websearch setup 或 /websearch provider；RPC 不接收密钥。也可用 /websearch provider auto|deepseek|anysearch 切换策略", "info");
      return;
    }
    const expected = this.snapshot();
    const adapters = orderedProviders();
    const modes = [{ id: "auto", label: "自动（优先 DeepSeek）" }, ...adapters.map(a => ({ id: a.id, label: a.label }))];
    const choices = modes.map(mode => mode.label + (mode.id === client.providerMode ? "（当前）" : ""));
    const selected = argument ?? await ctx.ui.select("选择搜索策略", choices, { signal });
    signal.throwIfAborted();
    if (selected === undefined) return;
    const mode = argument ? modes.find(item => item.id === argument)?.id : modes[choices.indexOf(selected)]?.id;
    if (!mode) throw new ApiError(400, `渠道无效，可选 ${modes.map(item => item.id).join("、")}`);
    const patch: Record<string, string> = { provider: mode };
    let activeProvider = client.provider;
    const activate = (next: SearchClient) => { apply(next); activeProvider = next.provider; };
    if (command === "setup") {
      const adapterChoice = mode === "auto" ? await ctx.ui.select("为哪个渠道配置凭据？自动策略仍优先 DeepSeek", adapters.map(a => a.label), { signal })
        : adapters.find(a => a.id === mode)?.label;
      signal.throwIfAborted();
      const adapter = adapters.find(a => a.label === adapterChoice);
      if (!adapter) return;
      const methods = adapter.registration ? ["已有 API Key（隐藏输入）", "使用真实邮箱注册并获取 API Key"] : ["已有 API Key（隐藏输入）"];
      const method = adapter.registration ? await ctx.ui.select(`${adapter.label} 接入方式`, methods, { signal }) : methods[0];
      signal.throwIfAborted();
      if (!method) return;
      let key: string | undefined;
      if (method === methods[1] && adapter.registration) {
        const email = (await ctx.ui.input(`输入真实可接收邮件的邮箱（用于创建 ${adapter.label} 账号）`, undefined, { signal }))?.trim();
        signal.throwIfAborted();
        if (!email) return;
        const confirmed = await ctx.ui.confirm("确认注册并保存密钥", `将把此邮箱发送至 ${adapter.label} 官方服务创建账号，并将获得的密钥以明文保存到个人配置文件。不会自动重复注册；现有账号请改用已有密钥。是否继续？`, { signal });
        signal.throwIfAborted();
        if (!confirmed) return;
        key = await commandRequest(ctx, signal, `正在注册 ${adapter.label}（只发送一次请求）`, active => adapter.registration!.createKey(email, this.options.fetchImpl ?? fetch, active));
        if (!key || signal.aborted) {
          if (!signal.aborted) ctx.ui.notify(`注册已取消，账号可能已创建。请先登录 ${adapter.registration.loginUrl} 确认，不会自动重复注册`, "warning");
          return;
        }
        // A newly issued official key must not inherit an old custom/proxy endpoint.
        const baseField = adapter.credentials.baseUrlFields[0];
        if (baseField) patch[baseField] = adapter.defaultBaseUrl;
      } else {
        key = await maskedKey(ctx, `${adapter.label} API Key`, signal);
        signal.throwIfAborted();
        if (!key) return;
        if (!(await ctx.ui.confirm("保存并立即生效", "密钥将以明文保存在个人配置文件中，不进入对话记录。是否保存？", { signal }))) return;
      }
      signal.throwIfAborted();
      patch[adapter.credentials.keyFields[0]] = key;
      try { await this.save(patch, expected, signal, activate); }
      catch (error) {
        if (method === methods[1] && adapter.registration) ctx.ui.notify(`账号可能已创建，但本地保存未完成。请登录 ${adapter.registration.loginUrl} 获取密钥；不会自动重复注册`, "warning");
        throw error;
      }
    } else await this.save(patch, expected, signal, activate);
    ctx.ui.notify(`搜索配置已保存并立即生效，当前渠道：${activeProvider}；无需 /reload 或重启。可运行 /websearch status 查看凭据状态与选择原因`, "info");
  }
}
