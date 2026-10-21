import { Text } from "@earendil-works/pi-tui";
import type { EditToolInput, Theme } from "@earendil-works/pi-coding-agent";

/** Native result renderer renders the verified diff; no old-matcher preview is started. */
export function renderEditCall(args: EditToolInput, theme: Theme): Text {
  const path = typeof args?.path === "string" ? args.path.replace(/[\u0000-\u001f\u007f]/g, "") : "";
  const count = Array.isArray(args?.edits) ? args.edits.length : 0;
  return new Text(theme.fg("toolTitle", theme.bold("edit")) + " " + path +
    (count ? " · " + count + " block(s)" : ""), 0, 0);
}
