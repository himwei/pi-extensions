import assert from "node:assert/strict";
import { buildRenamePrompt, buildTopicDigest, cleanSessionName, dropSlashCommandMessages } from "../ai-rename.js";

// cleanSessionName: takes the first meaningful line, strips wrapping quotes,
// fences, command tokens, and trailing punctuation; caps length safely.
assert.equal(cleanSessionName("修复WSL无线网卡驱动"), "修复WSL无线网卡驱动");
assert.equal(cleanSessionName("\n\n  修复WiFi驱动  \n后续内容忽略\n"), "修复WiFi驱动");
assert.equal(cleanSessionName("「整理扩展清单」"), "整理扩展清单");
assert.equal(cleanSessionName('`fix driver`'), "fix driver");
assert.equal(cleanSessionName("整理扩展清单。"), "整理扩展清单");
assert.equal(cleanSessionName("Done. Still done."), "Done. Still done"); // only trailing punctuation goes
assert.equal(cleanSessionName("v1.2.3"), "v1.2.3");
assert.equal(cleanSessionName("   "), undefined);
assert.equal(cleanSessionName(""), undefined);
assert.equal(cleanSessionName("\n\n"), undefined);
assert.equal(cleanSessionName("!!!"), undefined);
// Surrogate-safe length cap.
const long = "🛠️修".repeat(30);
const capped = cleanSessionName(long);
assert.equal(Array.from(capped ?? "").length, 40);
// Slash-command tokens are stripped from names.
assert.equal(cleanSessionName("开发AI会话命名扩展 /n"), "开发AI会话命名扩展");
assert.equal(cleanSessionName("/name 重命名测试"), "重命名测试");
assert.equal(cleanSessionName("修复 /wsl 驱动"), "修复 驱动");

// dropSlashCommandMessages: user slash-command invocations (including the
// "/n" that triggers naming) are dropped; real content survives.
const filtered = dropSlashCommandMessages([
	{ role: "user", content: "帮我修复驱动" },
	{ role: "user", content: "/n" },
	{ role: "user", content: "/name 旧名字" },
	{ role: "assistant", content: [{ type: "text", text: "好的" }] },
	{ role: "user", content: [{ type: "text", text: "再检查一下" }] },
]);
assert.equal(filtered.length, 3);
assert.ok(filtered.some((m) => (m as { role: string }).role === "assistant"));
assert.ok(filtered.some((m) => (m as { content: string }).content === "帮我修复驱动"));
assert.ok(filtered.some((m) => Array.isArray((m as { content: unknown[] }).content)));

// buildTopicDigest: every user input in order (whitespace-collapsed), only the
// FIRST assistant reply, caps applied, middle inputs omitted past 30.
const digest = buildTopicDigest([
	{ role: "user", content: "帮我修复\nWSL的无线网卡驱动" },
	{ role: "assistant", content: [{ type: "text", text: "先看驱动日志" }] },
	{ role: "assistant", content: [{ type: "text", text: "第二条回复不该入选" }] },
	{ role: "user", content: [{ type: "text", text: "再检查一下编译" }] },
]);
assert.deepEqual(digest.userInputs, ["帮我修复 WSL的无线网卡驱动", "再检查一下编译"]);
assert.equal(digest.firstReply, "先看驱动日志");
assert.equal(digest.omittedInputs, 0);

// Long single input is capped with an ellipsis, surrogate-safe.
const longInput = "🛠️x".repeat(150);
const cappedDigest = buildTopicDigest([{ role: "user", content: longInput }]);
assert.equal(Array.from(cappedDigest.userInputs[0] ?? "").length, 201); // 200 + ellipsis
assert.ok((cappedDigest.userInputs[0] ?? "").endsWith("…"));

// >30 inputs: first 15 + last 15 survive, omission is counted and reported.
const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `任务${i}` }));
const big = buildTopicDigest(many);
assert.equal(big.userInputs.length, 30);
assert.equal(big.omittedInputs, 10);
assert.equal(big.userInputs[0], "任务0");
assert.equal(big.userInputs.at(-1), "任务39");

// buildRenamePrompt: whole-task framing, numbered inputs, first reply, rules.
const prompt = buildRenamePrompt(digest);
assert.ok(prompt.includes("<用户输入>"));
assert.ok(prompt.includes("1. 帮我修复 WSL的无线网卡驱动"));
assert.ok(prompt.includes("2. 再检查一下编译"));
assert.ok(prompt.includes("先看驱动日志"));
assert.ok(prompt.includes("整体任务"));
assert.ok(prompt.includes("不要只描述最后一轮"));
const omittedPrompt = buildRenamePrompt(big);
assert.ok(omittedPrompt.includes("中间省略 10 条"));

process.stdout.write("ai-rename: all assertions passed\n");
