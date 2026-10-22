/**
 * permission-gate/dialog.ts — 紧凑确认框（定稿样式的运行时实现）
 *
 * 结构（与 gate-preview.ps1 设计稿一致，6-8 行）：
 *   ─── 边线（高危 error / 中危 warning 色）
 *   ⛔ 高危 · <规则中文名>                      标题一行
 *   <命令原文 ≤3 行，危险片段反白，多行带行号>
 *   目标 <路径缩略> · <后果一句话> · 全文 N 行 N B
 *   [n] 阻止（默认）   [y] 允许一次   [a] 本会话允许   ←→ 选择 · ⏎ 确认 · esc 取消
 *   ─── 边线
 *
 * ←/→ 在选项间移动（提权只有取消/一次；钳位，选中项仅以严重度色加粗区分）；
 * Enter 确认选中项（默认选中「阻止」）；n/y/a 仍是直接快捷键；esc = 取消。
 * 非提权的 a = 按命令 sha256 记入会话放行名单；overlay 不替换编辑器；abort 时通过 done 回调关闭。
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { CommandPreview, GateSeverity } from "./policy.js";

export type GateOutcome = "allowed-once" | "allowed-session" | "rejected" | "cancelled" | "unavailable";
export type GateUserOutcome = Exclude<GateOutcome, "unavailable">;

export interface GateDialogData {
  zh: string;
  severity: GateSeverity;
  consequence: string;
  target?: string;
  preview: CommandPreview;
  /** Offsets into the original command for the inverted danger segment. */
  danger: { start: number; end: number };
  additionalDangers?: Array<{ start: number; end: number }>;
  /** Controls rendering, navigation AND direct shortcuts. Defaults preserve destructive-command dialogs. */
  allowSession?: boolean;
  onceLabel?: string;
  rejectLabel?: string;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export class GateConfirmComponent implements Component {
  private readonly options: Array<{ key: string; label: string; outcome: GateUserOutcome }>;

  private readonly tui: TUI | undefined;
  private readonly theme: Theme;
  private readonly data: GateDialogData;
  private readonly onDone: (outcome: GateUserOutcome) => void;
  private finished = false;
  private selectedIndex = 0;

  constructor(opts: { tui?: TUI; theme: Theme; data: GateDialogData; onDone: (outcome: GateUserOutcome) => void }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.data = opts.data;
    this.onDone = opts.onDone;
    this.options = [
      { key: "n", label: opts.data.rejectLabel ?? "阻止（默认）", outcome: "rejected" },
      { key: "y", label: opts.data.onceLabel ?? "允许一次", outcome: "allowed-once" },
    ];
    if (opts.data.allowSession !== false) this.options.push({ key: "a", label: "本会话允许", outcome: "allowed-session" });
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.finish("cancelled");
    else if (matchesKey(data, "left")) this.moveSelection(-1);
    else if (matchesKey(data, "right")) this.moveSelection(1);
    else if (matchesKey(data, "return")) {
      this.finish(this.options[this.selectedIndex]?.outcome ?? "rejected");
    } else {
      const option = this.options.find(option => option.key === data.toLowerCase());
      if (option) this.finish(option.outcome);
    }
  }

  render(width: number): string[] {
    const sev: "error" | "warning" = this.data.severity === "high" ? "error" : "warning";
    const border = this.theme.fg(sev, "─".repeat(Math.max(1, width)));
    const lines = [border, this.renderTitle(sev), ...this.renderCommandLines(width, sev), this.renderInfoLine(), this.renderKeysLine(sev), border];
    // 最后兜底：保证每行都在宽度内（拼接样式后理论上不会超出，防御宽字符误差）。
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {
    // 每次渲染现算，无缓存。
  }

  private finish(outcome: GateUserOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.onDone(outcome);
  }

  /** 钳位移动（与内建列表的 ↑↓ 一致）；选中态变化需要主动请求重绘。 */
  private moveSelection(delta: number): void {
    if (this.finished) return;
    const next = this.selectedIndex + delta;
    if (next < 0 || next >= this.options.length || next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.tui?.requestRender();
  }

  private renderTitle(sev: "error" | "warning"): string {
    const icon = this.data.severity === "high" ? "⛔" : "⚠";
    const sevZh = this.data.severity === "high" ? "高危" : "中危";
    return this.theme.style(` ${icon} ${sevZh} · ${this.data.zh}`, { fg: sev, bold: true });
  }

  private renderCommandLines(width: number, sev: "error" | "warning"): string[] {
    const { preview, danger, additionalDangers = [] } = this.data;
    const digits = String(Math.max(preview.totalLines, preview.lines.length)).length;
    const out: string[] = [];
    preview.lines.forEach((line, i) => {
      const prefix = preview.multi ? ` ${this.theme.fg("dim", `${String(i + 1).padStart(digits)} `)}` : "  ";
      const budget = Math.max(8, width - visibleWidth(prefix) - 1);
      let text = line.text;
      let shownEnd = line.end;
      if (visibleWidth(text) > budget) {
        const cut = sliceByColumn(text, 0, budget - 1);
        text = `${cut}…`;
        shownEnd = line.start + cut.length;
      }
      // 危险区间与本行可见区间求交；映射到（可能截断后的）行内偏移。
      const spans = [danger, ...additionalDangers].map(span => ({
        start: Math.max(span.start, line.start) - line.start,
        end: Math.min(span.end, shownEnd) - line.start,
      })).filter(span => span.start < span.end).sort((a, b) => a.start - b.start);
      const merged: typeof spans = [];
      for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else merged.push({ ...span });
      }
      const invertBg = sev === "error" ? this.theme.colors.error : this.theme.colors.warning;
      let content = "";
      let offset = 0;
      for (const span of merged) {
        content += text.slice(offset, span.start) + this.theme.style(text.slice(span.start, span.end), { bg: invertBg, bold: true });
        offset = span.end;
      }
      content += text.slice(offset);
      out.push(prefix + content);
    });
    return out;
  }

  private renderInfoLine(): string {
    const { preview, target, consequence } = this.data;
    const dim = (s: string) => this.theme.fg("dim", s);
    let info = " ";
    if (target) info += dim("目标 ") + target + dim(" · ");
    info += consequence;
    if (preview.multi || preview.truncated) {
      info += dim(` · 全文 ${preview.totalLines} 行 ${formatBytes(preview.bytes)}`);
    }
    return info;
  }

  private renderKeysLine(sev: "error" | "warning"): string {
    const dim = (s: string) => this.theme.fg("dim", s);
    const chips: string[] = [];
    this.options.forEach((option, i) => {
      const chip = `[${option.key}] ${option.label}`;
      chips.push(i === this.selectedIndex ? this.theme.style(chip, { fg: sev, bold: true }) : dim(chip));
    });
    return " " + chips.join(dim("   ")) + dim("   ←→ 选择 · ⏎ 确认 · esc 取消");
  }
}

/**
 * 打开 overlay 并等待决策。用户按键或 abort 都必须通过工厂传入的 done 回调关闭
 * overlay（它同时 resolve custom() 的 Promise、恢复编辑器）；只 resolve 本函数的
 * Promise 会让 overlay 永远留在屏幕上并持有键盘焦点。两处均幂等。
 */
export async function overlayDecision(
  ui: Pick<ExtensionUIContext, "custom">,
  data: GateDialogData,
  signal?: AbortSignal,
): Promise<GateOutcome> {
  if (signal?.aborted) return "cancelled";
  return new Promise<GateOutcome>((resolve) => {
    let settled = false;
    let doneRef: ((outcome: GateUserOutcome) => void) | undefined;
    const finish = (outcome: GateOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const complete = (outcome: GateUserOutcome) => {
      finish(outcome);
      doneRef?.(outcome); // 关闭 overlay（已 settle 时也补调，防孤儿窗口）
    };
    const onAbort = () => complete("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(
      ui.custom<GateUserOutcome>(
        (_tui, theme, _kb, done) => {
          doneRef = done;
          const component = new GateConfirmComponent({ tui: _tui, theme, data, onDone: complete });
          // 工厂运行前已经 abort/结束：立即收尾，不留孤儿 overlay。
          if (settled) complete("cancelled");
          return component;
        },
        { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", margin: { bottom: 1 } } },
      ),
    ).then(finish, () => finish(signal?.aborted ? "cancelled" : "unavailable"));
  });
}
