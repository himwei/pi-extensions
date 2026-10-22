import assert from "node:assert/strict";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GateConfirmComponent, overlayDecision, type GateDialogData } from "./dialog.js";
import { buildCommandPreview } from "./policy.js";

const theme = {
  fg: (_c: string, s: string) => s,
  style: (s: string) => s,
  bold: (s: string) => s,
  colors: { error: "#e5484d", warning: "#f5a524" },
} as unknown as Theme;

const command =
  "Get-ChildItem build |\n" +
  "  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |\n" +
  "  Remove-Item -Recurse -Force $_";
const data: GateDialogData = {
  zh: "递归删除",
  severity: "high",
  consequence: "目录及全部内容将被永久删除，回收站不保留，不可撤销",
  target: "C:\\…\\Desktop\\build",
  preview: buildCommandPreview(command, 3),
  danger: { start: command.indexOf("-Recurse"), end: command.indexOf("-Recurse") + "-Recurse -Force".length },
};

// 键位映射：n/Enter=阻止（安全默认），y=允许一次，a=会话允许，esc=取消；首决策生效。
const outcomes: string[] = [];
const press = (key: string) => {
  const comp = new GateConfirmComponent({ theme, data, onDone: (o) => outcomes.push(o) });
  comp.handleInput(key);
};
press("n");
press("y");
press("a");
press("\x1b");
press("\r");
press("N");
assert.deepEqual(outcomes, ["rejected", "allowed-once", "allowed-session", "cancelled", "rejected", "rejected"]);
const once = new GateConfirmComponent({ theme, data, onDone: (o) => outcomes.push(o) });
once.handleInput("y");
once.handleInput("a");
assert.equal(outcomes[outcomes.length - 1], "allowed-once");

// ←/→ 选择 + ⏎ 确认选中项（钳位；选中项仅颜色区分，无额外标记）
const clamp = new GateConfirmComponent({ theme, data, onDone: (o) => outcomes.push(o) });
clamp.handleInput("\x1b[D"); // ← 在首位：钳位不动
clamp.handleInput("\r"); // 确认默认选中 → 阻止
assert.equal(outcomes[outcomes.length - 1], "rejected");
const step1 = new GateConfirmComponent({ theme, data, onDone: (o) => outcomes.push(o) });
step1.handleInput("\x1b[C"); // → 允许一次
step1.handleInput("\r");
assert.equal(outcomes[outcomes.length - 1], "allowed-once");
const step2 = new GateConfirmComponent({ theme, data, onDone: (o) => outcomes.push(o) });
step2.handleInput("\x1b[C");
step2.handleInput("\x1b[C"); // → 本会话允许
step2.handleInput("\x1b[C"); // 末位：钳位不动
step2.handleInput("\r");
assert.equal(outcomes[outcomes.length - 1], "allowed-session");

// 渲染：2 边线 + 标题 + 3 命令行 + 信息行 + 键位行 = 8 行，且全部不超过给定宽度。
const comp = new GateConfirmComponent({ theme, data, onDone: () => {} });
const wide = comp.render(80);
assert.equal(wide.length, 8);
assert.ok(wide.every((line) => visibleWidth(line) <= 80), "every line fits 80 columns");
assert.ok(wide[1]!.includes("⛔ 高危 · 递归删除"));
assert.ok(wide[2]!.includes("1 Get-ChildItem build |"), "multi-line preview keeps line numbers");
assert.ok(wide[6]!.includes("[n] 阻止（默认）"));
assert.ok(wide[6]!.includes("←→ 选择"), "keys line advertises arrow selection");
assert.ok(wide[6]!.includes("esc 取消"));
const narrow = comp.render(36);
assert.ok(narrow.every((line) => visibleWidth(line) <= 36), "every line fits 36 columns");

const single: GateDialogData = {
  zh: "Git 强制重置",
  severity: "medium",
  consequence: "未提交的修改与暂存内容将被永久丢弃，不可撤销",
  preview: buildCommandPreview("git reset --hard HEAD~3", 3),
  danger: { start: 11, end: 17 },
};
const singleLines = new GateConfirmComponent({ theme, data: single, onDone: () => {} }).render(80);
assert.equal(singleLines.length, 6, "single-line command renders 6 lines");
assert.ok(singleLines[1]!.includes("⚠ 中危 · Git 强制重置"));
assert.ok(singleLines[2]!.includes("git reset "), "single-line preview carries no line numbers");
assert.ok(!singleLines[3]!.includes("全文"), "single short line omits the 全文 suffix");

// overlayDecision：组件输入 → 决策；abort → 取消并关闭；预先 abort → 直接取消。
type FakeFactory = (
  tui: unknown,
  theme: Theme,
  keybindings: unknown,
  done: (result: unknown) => void,
) => GateConfirmComponent;
let interacted: GateConfirmComponent | undefined;
const ui = {
  custom: (factory: FakeFactory) =>
    new Promise(() => {
      interacted = factory(undefined, theme, undefined, () => {});
    }),
} as unknown as Pick<ExtensionUIContext, "custom">;
const decision = overlayDecision(ui, data);
await Promise.resolve();
interacted!.handleInput("a");
assert.equal(await decision, "allowed-session");

// 回归：用户按键必须同时触发工厂的 done 回调——只 resolve 决策 Promise 的话，
// overlay 永远留在屏幕上并持有键盘焦点，界面看起来卡死。
const dones: string[] = [];
let decided: GateConfirmComponent | undefined;
const uiDone = {
  custom: (factory: FakeFactory) =>
    new Promise<unknown>((resolve) => {
      decided = factory(undefined, theme, undefined, (result) => {
        dones.push(String(result));
        resolve(result);
      });
    }),
} as unknown as Pick<ExtensionUIContext, "custom">;
const donePending = overlayDecision(uiDone, data);
await Promise.resolve();
decided!.handleInput("y");
assert.equal(await donePending, "allowed-once");
assert.deepEqual(dones, ["allowed-once"], "decision must close the overlay via done");

const controller = new AbortController();
let abortable: GateConfirmComponent | undefined;
const uiAbort = {
  custom: (factory: FakeFactory) =>
    new Promise(() => {
      abortable = factory(undefined, theme, undefined, () => {});
    }),
} as unknown as Pick<ExtensionUIContext, "custom">;
const racing = overlayDecision(uiAbort, data, controller.signal);
controller.abort();
assert.equal(await racing, "cancelled");
assert.equal(await overlayDecision(ui, data, AbortSignal.abort()), "cancelled");

// Readiness dialogs expose only cancel/once in rendering, navigation and direct keys.
const readyData = { ...single, allowSession: false, onceLabel: "已就绪，执行一次", rejectLabel: "取消此次（默认）" };
const readyOutcomes: string[] = [];
const ready = new GateConfirmComponent({ theme, data: readyData, onDone: o => readyOutcomes.push(o) });
const readyLines = ready.render(160).join("\n");
assert.ok(!readyLines.includes("[a]"));
assert.ok(readyLines.includes("已就绪，执行一次"));
ready.handleInput("a");
ready.handleInput("A");
assert.deepEqual(readyOutcomes, [], "hidden session approval cannot be selected by shortcut");
ready.handleInput("\x1b[C");
ready.handleInput("\x1b[C");
ready.handleInput("\r");
assert.deepEqual(readyOutcomes, ["allowed-once"], "right arrow clamps at once");
assert.ok(ready.render(36).every(line => visibleWidth(line) <= 36));

const highlighted: string[] = [];
const recordingTheme = { ...theme, style: (text: string, opts: { bg?: string }) => {
  if (opts.bg) highlighted.push(text);
  return text;
} } as unknown as Theme;
new GateConfirmComponent({ theme: recordingTheme, data: {
  ...single, preview: buildCommandPreview("abcdefghi"), danger: { start: 1, end: 4 },
  additionalDangers: [{ start: 3, end: 5 }, { start: 7, end: 9 }],
}, onDone() {} }).render(100);
assert.deepEqual(highlighted, ["bcde", "hi"], "overlapping highlights merge without duplicating source");

console.log("gate dialog component tests passed");
