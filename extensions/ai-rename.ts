/**
 * /n — rename the current session (and therefore the terminal tab title).
 *
 * - `/n` — ask the current model to derive a short display name from the
 *   conversation itself ("按当前会话内容命名"). Manual, never automatic.
 * - `/n <名字>` — set the name directly, no model call.
 *
 * Why not `/name`: interactive mode dispatches `/name` via a hardcoded text
 * match that runs before any extension command lookup, and a colliding
 * extension registration is skipped entirely (autocomplete included). The
 * builtin `/name <name>` keeps direct naming; `/n` is the shortest free name
 * and carries both modes.
 *
 * The model call mirrors auto-summary's pattern (session's own model and key,
 * billed via the shared "summary-usage" fact) but feeds a topic digest
 * instead of the full transcript: all user messages plus the AI's first text
 * reply — intent lives in the questions, and the recency bias of a tail-heavy
 * excerpt made names describe only the last thing that happened.
 *
 * Bonus: notify-dot matches its WT tab by the ` - <session> - <cwd>` title
 * suffix, so a named session also makes same-directory tabs distinguishable.
 */
import { complete } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { recordSummaryUsage } from "./auto-summary.js";

const MAX_NAME_CHARS = 40;
const MAX_OUTPUT_TOKENS = 64;
/** Topic digest caps: user inputs carry intent; assistant replies are noise. */
const MAX_INPUT_CHARS = 200;
const MAX_INPUTS = 30; // beyond this: first 15 + last 15, middle omitted
const MAX_REPLY_CHARS = 600;

const extractAssistantText = (message: AssistantMessage): string =>
	message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");

/** Keep the head (goal) plus most of the tail (what actually happened). */
export interface TopicDigest {
	/** User messages in order, whitespace-collapsed, each capped. */
	userInputs: string[];
	/** First assistant text reply, capped. */
	firstReply?: string;
	/** How many middle user inputs were omitted past MAX_INPUTS. */
	omittedInputs: number;
}

const messageText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			(part as { type?: unknown; text?: unknown })?.type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join(" ");
};

const cap = (text: string, max: number): string => {
	const chars = Array.from(text);
	return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`;
};

/** Distill a branch into the intent signal: every user ask + the opening reply. */
export function buildTopicDigest(messages: unknown[]): TopicDigest {
	const userInputs: string[] = [];
	let firstReply: string | undefined;
	for (const message of messages) {
		const m = message as { role?: unknown; content?: unknown };
		const text = messageText(m?.content).replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (m?.role === "user") userInputs.push(cap(text, MAX_INPUT_CHARS));
		else if (m?.role === "assistant" && firstReply === undefined) {
			firstReply = cap(text, MAX_REPLY_CHARS);
		}
	}
	let omittedInputs = 0;
	if (userInputs.length > MAX_INPUTS) {
		omittedInputs = userInputs.length - 30;
		userInputs.splice(15, omittedInputs);
	}
	return { userInputs, firstReply, omittedInputs };
}

export function buildRenamePrompt(digest: TopicDigest): string {
	const inputs = digest.userInputs
		.map((text, index) => `${index + 1}. ${text}`)
		.join("\n");
	const omitted = digest.omittedInputs > 0 ? `（…中间省略 ${digest.omittedInputs} 条…）\n` : "";
	return [
		"你是会话命名器。根据 <用户输入>（按时间顺序的全部用户消息）和 <会话首次回复>（助手第一条文本回复）判断这个会话的主题，起一个简短的显示名（用于终端标签标题和会话列表）。",
		"要求：",
		"- 概括会话的整体任务：以贯穿始终的主要目标为准，不要只描述最后一轮做了什么",
		"- 跟随对话的主要语言；2~6 个词（中文 2~12 个字）",
		"- 不含文件路径、版本号、引号、书名号；不以标点结尾",
		"- 忽略用户输入中的命令本身（如 /n、/name），名字里不要出现斜杠或命令词",
		"- 只输出名字本身，不要任何解释、前后缀或代码围栏",
		"",
		"<用户输入>",
		inputs || "（无）",
		omitted,
		"</用户输入>",
		"",
		"<会话首次回复>",
		digest.firstReply ?? "（无）",
		"</会话首次回复>",
	].join("\n");
}

/** Normalize a model answer (or an explicit /n argument) into a clean title. */
export function cleanSessionName(raw: string): string | undefined {
	const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
	let name = firstLine
		// Surrounding quotes and code fences; internal punctuation survives.
		.replace(/^[「『"'`“”]+|[」』"'`“”]+$/g, "")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\s+/g, " ")
		// Slash-command tokens (e.g. a leaked "/n" invocation) never belong in a name.
		.replace(/(^|\s)\/\S+/gu, "$1")
		.replace(/\s+/g, " ")
		.replace(/[。．.!?！？:：;；,，、~～]+$/u, "")
		.trim();
	if (name.length > MAX_NAME_CHARS) {
		name = Array.from(name).slice(0, MAX_NAME_CHARS).join("").trim();
	}
	return name.length > 0 ? name : undefined;
}

/** User messages that are slash-command invocations carry no topic signal. */
export function dropSlashCommandMessages(messages: unknown[]): unknown[] {
	return messages.filter((message) => {
		const m = message as { role?: unknown; content?: unknown };
		if (m?.role !== "user") return true;
		const content = m.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
						.map((part) => (part as { type?: unknown; text?: unknown })?.type === "text" ? String((part as { text?: unknown }).text ?? "") : "")
						.join(" ")
					: "";
		return !text.trim().startsWith("/");
	});
}

const pickModel = (
	ctx: ExtensionCommandContext,
	sessionModelId: { provider: string; modelId: string } | null | undefined,
) =>
	ctx.model ??
	(sessionModelId ? ctx.modelRegistry.find(sessionModelId.provider, sessionModelId.modelId) : undefined);

export default function aiRename(pi: ExtensionAPI) {
	let pending: AbortController | undefined;
	pi.on("session_shutdown", () => pending?.abort());
	// A rename racing a session switch would land on the wrong session.
	const preventNavigation = (_event: unknown, ctx: ExtensionContext) => {
		if (!pending) return undefined;
		ctx.ui.notify("/n 正在生成，请等待完成后再切换会话/分支", "warning");
		return { cancel: true };
	};
	pi.on("session_before_switch", preventNavigation);
	pi.on("session_before_fork", preventNavigation);
	pi.on("session_before_tree", preventNavigation);

	pi.registerCommand("n", {
		description: "无参数：按会话内容用当前模型起名；/n <名>：直接命名（/name <名> 亦可）",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (pending) {
				ctx.ui.notify("/n 正在生成，请先等待完成后再运行命名命令", "warning");
				return;
			}

			const explicit = cleanSessionName(args);
			if (args.trim() && !explicit) {
				ctx.ui.notify("/n 提供的名字无效", "warning");
				return;
			}
			if (explicit) {
				// Mirror the builtin `/name <name>` exactly (no routing API exists:
				// builtin commands are TUI-internal): set, read back, warn on
				// normalization, then confirm.
				pi.setSessionName(explicit);
				const applied = pi.getSessionName();
				if (applied !== explicit) {
					ctx.ui.notify(`/n 名字已规范化：${JSON.stringify(explicit)} → ${JSON.stringify(applied)}`, "warning");
				}
				ctx.ui.notify(`已命名会话：${applied ?? explicit}`, "info");
				return;
			}

			const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			// Slash-command invocations (including the "/n" that triggered this
			// handler) land in the branch as user messages; they pollute the digest
			// and the model folds them into the generated name. Drop them first.
			const digest = buildTopicDigest(dropSlashCommandMessages(sessionContext.messages));
			if (digest.userInputs.length === 0 && !digest.firstReply) {
				ctx.ui.notify("/n 当前分支没有可命名的会话内容", "warning");
				return;
			}

			const model = pickModel(ctx, sessionContext.model);
			if (!model) {
				ctx.ui.notify("/n 未找到当前模型，无法生成名字", "warning");
				return;
			}
			const controller = new AbortController();
			pending = controller;
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model<any>);
				if (controller.signal.aborted) return;
				if (!auth.ok) {
					ctx.ui.notify(`/n 模型鉴权失败：${auth.error}`, "warning");
					return;
				}
				if (!auth.apiKey) {
					ctx.ui.notify(`/n 未找到 ${model.provider}/${model.id} 的 API key`, "warning");
					return;
				}

				ctx.ui.notify(`/n 正在用 ${model.provider}/${model.id} 生成名字...`, "info");

				const response = await complete(
					model,
					{
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: buildRenamePrompt(digest) }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						maxTokens: Math.max(1, Math.min(MAX_OUTPUT_TOKENS, model.maxTokens ?? MAX_OUTPUT_TOKENS)),
						signal: controller.signal,
					},
				);

				recordSummaryUsage(pi, model, response);
				if (controller.signal.aborted || response.stopReason === "aborted") {
					ctx.ui.notify("/n 已取消", "info");
					return;
				}
				if (response.stopReason === "error") {
					ctx.ui.notify(`/n 模型生成失败：${response.errorMessage ?? "无错误详情"}`, "error");
					return;
				}

				const name = cleanSessionName(extractAssistantText(response));
				if (!name) {
					ctx.ui.notify("/n 模型没有返回可用的名字", "error");
					return;
				}
				pi.setSessionName(name);
				ctx.ui.notify(`已命名会话：${name}`, "info");
			} finally {
				pending = undefined;
			}
		},
	});
}
