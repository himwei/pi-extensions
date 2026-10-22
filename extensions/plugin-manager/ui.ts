/** Shared presentation; production receives Pi's current Theme unchanged. */
import { DynamicBorder, getSelectListTheme, getSettingsListTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { getTerminalColorMode, rgbColor, styleText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
export type Relation = "match" | "different";
const demoColors = {
  dark: { match: rgbColor(116, 177, 143), different: rgbColor(207, 116, 125) },
  light: { match: rgbColor(48, 119, 77), different: rgbColor(166, 55, 62) },
};
const cell = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "…", true);
export class ManagerStyle {
  private theme?: Theme;
  private appearance: "dark" | "light" = "dark";
  private divider = new DynamicBorder(text => this.theme ? this.theme.fg("borderMuted", text) : this.accent(text));
  constructor(theme: Theme | "dark" | "light") {
    if (typeof theme === "string") { this.appearance = theme; initTheme(theme, false); }
    else this.theme = theme;
  }
  accent(text: string) { return this.theme ? this.theme.fg("accent", text) : getSelectListTheme().selectedText(text); }
  muted(text: string) { return this.theme ? this.theme.fg("muted", text) : getSelectListTheme().description(text); }
  dim(text: string) { return this.theme ? this.theme.fg("dim", text) : getSettingsListTheme().hint(text); }
  border(width: number) { return this.divider.render(width)[0] ?? ""; }
  heading(text: string) { return this.accent(this.theme ? this.theme.bold(text) : styleText(text, { bold: true }, getTerminalColorMode())); }
  paint(text: string, relation?: Relation, focused = false): string {
    if (this.theme) return this.theme.style(text, { ...(relation ? { fg: relation === "match" ? "toolDiffAdded" : "toolDiffRemoved" } : {}),
      ...(focused ? { bold: true, underline: true } : {}) });
    return styleText(text, { ...(relation ? { fg: demoColors[this.appearance][relation] } : {}),
      ...(focused ? { bold: true, underline: true } : {}) }, getTerminalColorMode());
  }
}
export function renderHeader(style: ManagerStyle, width: number, context: { projectName: string; demo: boolean }): string {
  const right = context.demo ? width < 42 ? "DEMO" : `${context.projectName} · DEMO` : context.projectName;
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, width - 14));
  return cell("Extensions", rightWidth ? width - rightWidth - 1 : width) + (rightWidth ? " " + style.dim(cell(right, rightWidth)) : "");
}
