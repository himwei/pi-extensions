/** Shared presentation for the extension manager and demo; no persistence logic. */
import { DynamicBorder, getSelectListTheme, getSettingsListTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Extension, type SaveTarget, type View, type SettingsPaths } from "./state.js";

export const views: readonly View[] = ["all", "unselected", "selected", "settings"];
const labels: Record<View, string> = { all: "All", unselected: "Unselected", selected: "Selected", settings: "Settings" };
const shortLabels: Record<View, string> = { all: "All", unselected: "Off", selected: "On", settings: "Settings" };
const cell = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "…", true);

/** Built-in Pi themes, initialized only in this standalone preview process. */
export class PreviewStyle {
  private theme?: Theme;
  private divider = new DynamicBorder(text => this.theme ? this.theme.fg("borderMuted", text) : this.accent(text));
  constructor(appearance: "dark" | "light" | Theme) {
    if (typeof appearance === "string") this.setAppearance(appearance);
    else this.theme = appearance;
  }
  setAppearance(appearance: "dark" | "light") { initTheme(appearance, false); }
  accent(text: string) { return this.theme ? this.theme.fg("accent", text) : getSelectListTheme().selectedText(text); }
  muted(text: string) { return this.theme ? this.theme.fg("muted", text) : getSelectListTheme().description(text); }
  dim(text: string) { return this.theme ? this.theme.fg("dim", text) : getSettingsListTheme().hint(text); }
  border(width: number) { return this.divider.render(width)[0] ?? ""; }
}

/** Preserve both ends, clipping secondary text first on narrow terminals. */
function columns(left: string, right: string, width: number): string {
  if (!right) return cell(left, width);
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, width - 14));
  if (!rightWidth) return cell(left, width);
  return cell(left, width - rightWidth - 1) + " " + cell(right, rightWidth);
}

export function renderHeader(style: PreviewStyle, width: number, title: string, context: { projectName: string; demo: boolean }): string {
  const label = context.demo ? width < 42 ? "DEMO" : `${context.projectName} · DEMO` : context.projectName;
  return columns(title, style.dim(label), width);
}

export function renderTabs(style: PreviewStyle, width: number, current: View, counts: Record<View, number>): string {
  const make = (compact: boolean, showCounts: boolean) => views.map(view => {
    const label = compact ? shortLabels[view] : labels[view];
    return `${label}${showCounts && view !== "settings" ? ` ${counts[view]}` : ""}`;
  });
  let tabs = make(false, true);
  if (visibleWidth(tabs.join(" | ")) + 6 > width) tabs = make(false, false);
  if (visibleWidth(tabs.join(" | ")) + 6 > width) tabs = make(true, false);
  const showLabel = visibleWidth(tabs.join(" | ")) + 6 <= width;
  const separator = visibleWidth(tabs.join(" | ")) <= width ? " | " : " ";
  return truncateToWidth((showLabel ? style.muted("View: ") : "") + tabs.map((tab, i) =>
    views[i] === current ? style.accent(tab) : style.muted(tab)).join(style.dim(separator)), width, "…");
}

/** Compute columns from the whole inventory so search and scrolling do not move them. */
export function extensionTable(style: PreviewStyle, extensions: readonly Extension[], width: number) {
  const showScope = width >= 32;
  const preferred = Math.max(24, ...extensions.map(extension => visibleWidth(extension.name)));
  const nameWidth = Math.max(1, Math.min(36, preferred, width - 6 - (showScope ? 9 : 0)));
  const row = (prefix: string, name: string, scope: string) => cell(prefix, 6) + cell(name, nameWidth) +
    (showScope ? "  " + cell(scope, width - 8 - nameWidth) : "");
  return {
    header: style.dim(row("", "Extension", "Scope")),
    row(extension: Extension, selected: boolean, checked: boolean) {
      const prefix = `${selected ? "→ " : "  "}[${checked ? "x" : " "}] `;
      const scope = extension.source === "global" ? "Global" : "Project";
      return row(selected ? style.accent(prefix) : prefix, selected ? style.accent(extension.name) : extension.name, style.muted(scope));
    },
  };
}

interface SettingsView {
  paths: SettingsPaths;
  selected: number;
  autoAdd: boolean;
  savedAutoAdd: boolean;
  saveTarget: SaveTarget;
  savedSaveTarget: SaveTarget;
}

export function renderSettings(style: PreviewStyle, width: number, state: SettingsView): string[] {
  const settingsPaths = state.paths;
  const row = (index: number, label: string, value: string, values: readonly string[], dirty: boolean) => {
    const labelWidth = Math.max(6, Math.min(14, width - 16));
    const selected = state.selected === index;
    const primary = (text: string) => selected ? style.accent(text) : text;
    const choices = width >= 40 ? values.map(choice => choice === value ? primary(choice) : style.dim(choice)).join(style.dim(" | ")) : primary(value);
    return cell(primary(`${selected ? "→ " : "  "}${cell(label, labelWidth)}`) + choices + (dirty ? " *" : ""), width);
  };
  const explanations = {
    default: ["Default", "Follow Pi's native session tool selection behavior.", "Global preference. Existing active tools stay active.", `Mode settings: ${settingsPaths.preferences}`],
    auto: ["Auto", "Include eligible global-extension tools when resuming a session.", "Explicit tool contracts only. Restrictions and opt-in tools are respected.", `Mode settings: ${settingsPaths.preferences}`],
    global: ["Global", "Save global-extension defaults for all projects; keep existing project overrides.", "Project-only changes remain unsaved. Choose Project to apply them.", settingsPaths.global],
    project: ["Project", "Save extension selections for this project. Matching personal defaults need no override.", "Mode and the remembered destination are always saved globally.", settingsPaths.project],
  };
  const description = (parts: readonly string[], saved: string) => [
    style.muted(parts[0]),
    ...wrapTextWithAnsi(parts[1], width),
    ...wrapTextWithAnsi(style.muted(parts[2]), width),
    ...wrapTextWithAnsi(style.dim(parts[3]), width),
    ...wrapTextWithAnsi(style.dim(`Saved: ${saved}`), width),
  ];
  const modeSaved = state.savedAutoAdd ? "Auto" : "Default";
  const targetSaved = state.savedSaveTarget === "project" ? "Project" : "Global";
  const variants = [description(explanations.default, modeSaved), description(explanations.auto, modeSaved),
    description(explanations.global, targetSaved), description(explanations.project, targetSaved)];
  const selected = state.selected === 0 ? variants[state.autoAdd ? 1 : 0] : variants[state.saveTarget === "global" ? 2 : 3];
  const height = Math.max(...variants.map(lines => lines.length));
  return [row(0, "Mode", state.autoAdd ? "Auto" : "Default", ["Default", "Auto"], state.autoAdd !== state.savedAutoAdd),
    row(1, "Save to", state.saveTarget === "project" ? "Project" : "Global", ["Global", "Project"], state.saveTarget !== state.savedSaveTarget),
    "", ...selected, ...Array<string>(height - selected.length).fill("")];
}

interface FooterView {
  reloadRequired?: boolean;
  view: View | "details";
  saveTarget: SaveTarget;
  unsaved: number;
  notice: string;
  range?: string;
  canInherit?: boolean;
}

export function renderFooter(style: PreviewStyle, width: number, state: FooterView): string[] {
  const target = state.saveTarget === "project" ? "Project" : "Global";
  const pending = state.unsaved ? `${state.unsaved} unsaved change${state.unsaved === 1 ? "" : "s"}` : "Ready";
  const message = (state.unsaved ? `${pending}${state.notice ? ` · ${state.notice}` : ""}` : state.notice || pending) +
    (state.reloadRequired ? " · /reload required" : "");
  const status = columns(`${target} · ${message}`, style.dim(width >= 48 ? state.range ?? "" : ""), width);
  const hints = state.view === "settings" ? [
    "Tab Views · ↑↓ Select · ←→ Change · Ctrl+S Save · Esc Close",
    "Tab · ↑↓ Select · ←→ Change · ^S Save · Esc",
    "Tab · ↑↓ · ←→ · ^S · Esc",
  ] : state.view === "details" ? [
    state.canInherit ? "R Use personal default · Enter / Esc Back" : "Enter / Esc Back",
    state.canInherit ? "R Default · Enter / Esc Back" : "Enter / Esc Back",
    state.canInherit ? "R Default · Esc Back" : "Esc Back",
  ] : [
    "Tab Views · ↑↓ Move · Space Toggle · Enter Details · Ctrl+S Save · Esc Close",
    "Tab · ↑↓ · Space Toggle · Enter Details · ^S Save · Esc",
    "Tab · ↑↓ · Space · Enter · ^S · Esc",
    "Tab ↑↓ Space Enter ^S Esc",
  ];
  const hint = hints.find(text => visibleWidth(text) <= width) ?? hints[hints.length - 1];
  return [status, style.dim(truncateToWidth(hint, width, "…"))];
}
