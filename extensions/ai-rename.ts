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
 * Naming is shared with auto-summary through shared/session-name.ts (the
 * session's own model and key, billed via "extension-usage"). It feeds a topic digest
 * instead of the full transcript: all user messages plus the AI's first text
 * reply — intent lives in the questions, and the recency bias of a tail-heavy
 * excerpt made names describe only the last thing that happened.
 *
 * Bonus: notify-dot matches its WT tab by the ` - <session> - <cwd>` title
 * suffix, so a named session also makes same-directory tabs distinguishable.
 */
import {
	buildSessionContext,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { commandModel, commandOperation } from "./shared/model-call.js";
import { buildTopicDigest, cleanSessionName, dropSlashCommandMessages, generateSessionName } from "./shared/session-name.js";
export { buildRenamePrompt, buildTopicDigest, cleanSessionName, dropSlashCommandMessages, type TopicDigest } from "./shared/session-name.js";

export default function aiRename(pi: ExtensionAPI) {
	const operation = commandOperation(pi, "/n 正在生成，请等待完成后再切换会话/分支");

	pi.registerCommand("n", {
		description: "无参数：按会话内容用当前模型起名；/n <名>：直接命名（/name <名> 亦可）",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (operation.isPending()) {
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

			const model = commandModel(ctx, sessionContext.model);
			if (!model) {
				ctx.ui.notify("/n 未找到当前模型，无法生成名字", "warning");
				return;
			}
			const controller = operation.begin();
			try {
				ctx.ui.notify(`/n 正在用 ${model.provider}/${model.id} 生成名字...`, "info");

				const name = await generateSessionName(pi, ctx.modelRegistry, model, digest, controller.signal, "ai-rename");
				if (!name || controller.signal.aborted) {
					ctx.ui.notify("/n 已取消", "info");
					return;
				}
				pi.setSessionName(name);
				ctx.ui.notify(`已命名会话：${name}`, "info");
			} catch (error) {
				if (controller.signal.aborted) ctx.ui.notify("/n 已取消", "info");
				else ctx.ui.notify(`/n 失败：${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				operation.finish(controller);
			}
		},
	});
}
