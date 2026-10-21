export interface EditBlock { oldText: string; newText: string }
export interface MatchSpan { start: number; end: number; newText: string }
export interface EditPlan { content: string; spans: MatchSpan[]; usedWhitespaceMatch: boolean }
interface View { text: string; starts: number[]; ends: number[] }

/** Map retained code units and newline tokens back to their original spans. */
function makeView(source: string): View {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let start = 0;
  while (start < source.length) {
    const lf = source.indexOf("\n", start);
    const end = lf < 0 ? source.length : lf;
    const bodyEnd = lf >= 0 && end > start && source[end - 1] === "\r" ? end - 1 : end;
    let keptEnd = bodyEnd;
    while (keptEnd > start && (source[keptEnd - 1] === " " || source[keptEnd - 1] === "\t")) keptEnd--;
    for (let index = start; index < keptEnd; index++) {
      text += source[index];
      starts.push(index);
      ends.push(index + 1);
    }
    if (lf >= 0) {
      text += "\n";
      starts.push(bodyEnd);
      ends.push(lf + 1);
    }
    start = lf < 0 ? source.length : lf + 1;
  }
  return { text, starts, ends };
}

function occurrences(text: string, needle: string, accepts: (index: number) => boolean = () => true): number[] {
  const found: number[] = [];
  for (let offset = 0; offset <= text.length - needle.length;) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    if (accepts(index)) found.push(index);
    if (found.length === 2) break; // Only uniqueness matters.
    offset = index + 1;
  }
  return found;
}

function findSpan(view: View, needle: string, block: number, path: string): MatchSpan | undefined {
  if (!needle) return undefined;
  const matches = occurrences(view.text, needle);
  if (matches.length > 1) {
    throw new Error("Ambiguous edit block " + block + " in " + path +
      ": oldText matches more than once. Read more context and provide a unique oldText.");
  }
  if (!matches.length) return undefined;
  const offset = matches[0];
  return { start: view.starts[offset], end: view.ends[offset + needle.length - 1], newText: "" };
}

function exactSpan(source: string, needle: string, block: number, path: string): MatchSpan | undefined {
  // LF at the start of oldText must not split an existing CRLF token.
  const matches = occurrences(source, needle, index => !(source[index] === "\n" && source[index - 1] === "\r"));
  if (matches.length > 1) {
    throw new Error("Ambiguous edit block " + block + " in " + path +
      ": oldText matches more than once. Read more context and provide a unique oldText.");
  }
  return matches.length ? { start: matches[0], end: matches[0] + needle.length, newText: "" } : undefined;
}

/** Matching and application are pure; no filesystem, session, or UI dependencies. */
export function planEdits(source: string, edits: readonly EditBlock[], path: string): EditPlan {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits must contain at least one edit block.");
  let fuzzy: View | undefined;
  const ending = source.match(/\r?\n/)?.[0] ?? "\n";
  let usedWhitespaceMatch = false;
  const spans = edits.map((edit, index) => {
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.oldText.length) {
      throw new Error("Each edit requires a non-empty oldText and a string newText.");
    }
    let span = exactSpan(source, edit.oldText, index + 1, path);
    if (!span) {
      fuzzy ??= makeView(source);
      span = findSpan(fuzzy, makeView(edit.oldText).text, index + 1, path);
      if (span && /^[ \t]+\r?\n/.test(edit.oldText)) {
        while (source[span.start - 1] === " " || source[span.start - 1] === "\t") span.start--;
      }
      // If oldText explicitly includes its final line's trailing whitespace,
      // that whitespace belongs to the replaced span even when it differs.
      if (span && /[ \t]$/.test(edit.oldText)) {
        while (source[span.end] === " " || source[span.end] === "\t") span.end++;
        if (span.end < source.length && source[span.end] !== "\n" && source.slice(span.end, span.end + 2) !== "\r\n") span = undefined;
      }
      usedWhitespaceMatch ||= span !== undefined;
    }
    if (!span) {
      throw new Error("No match for edit block " + (index + 1) + " in " + path +
        ". Read the relevant content and copy an accurate, unique oldText. Only line endings and trailing spaces/tabs are tolerated.");
    }
    span.newText = edit.newText.replace(/\r\n/g, "\n").replace(/\n/g, ending);
    if (source.slice(span.start, span.end) === span.newText) {
      throw new Error("No changes in edit block " + (index + 1) + " for " + path + ". Supply a content-changing edit.");
    }
    return span;
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < spans.length; index++) {
    if (spans[index].start < spans[index - 1].end) {
      throw new Error("Overlapping edit blocks in " + path + ". Merge overlapping or nested changes into one block.");
    }
  }
  let content = source;
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    content = content.slice(0, span.start) + span.newText + content.slice(span.end);
  }
  return { content, spans, usedWhitespaceMatch };
}
