import {
  createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile, generateDiffString, generateUnifiedPatch,
  withFileMutationQueue,
  type EditToolInput, type ReadOperations, type ReadToolInput, type WriteOperations,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { FileAccess, encodeUtf8, resolveToolPath, uncertainWrite, type FileSnapshot } from "./files.js";
import { planEdits } from "./matcher.js";
import { ObservationStore, type LineRange, type ObservationToken } from "./observations.js";
import { applyTransforms, TRANSFORMS, type WriteTransform } from "./transforms.js";
import { renderEditCall } from "./render.js";

export interface EnhancedToolOptions {
  store?: ObservationStore;
  files?: FileAccess;
  transforms?: readonly WriteTransform[];
}

/** Derive source coverage using Pi's truncation, never its human-readable footer. */
export function readCoverage(text: string, input: ReadToolInput, truncation?: TruncationResult): { total: number; range: LineRange } | undefined {
  const offset = input.offset ?? 1;
  const limit = input.limit;
  if (!Number.isInteger(offset) || offset < 1 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) return undefined;
  if (text === "") return offset === 1 ? { total: 0, range: [1, 0] } : undefined;
  const lines = text.split("\n");
  const total = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const start = offset - 1;
  if (start >= total) return undefined;
  const selectedLines = lines.slice(start, limit === undefined ? undefined : start + limit);
  if (truncation?.firstLineExceedsLimit) return undefined;
  // Non-truncated selections may end in real blank rows that truncateHead does
  // not count (it excludes a trailing synthetic empty row).
  const shown = truncation?.truncated ? truncation.outputLines : Math.min(total - start, selectedLines.length);
  if (shown === 0) return undefined;
  return { total, range: [offset, Math.min(total, start + shown)] };
}

export function createEnhancedTools(cwd: string, options: EnhancedToolOptions = {}) {
  const store = options.store ?? new ObservationStore();
  const files = options.files ?? new FileAccess();
  const transforms = options.transforms ?? TRANSFORMS;
  const active = (epoch: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("Operation aborted");
    store.assertEpoch(epoch);
  };
  const nativeRead = createReadToolDefinition(cwd);
  const nativeWrite = createWriteToolDefinition(cwd);
  const nativeEdit = createEditToolDefinition(cwd);

  const read: typeof nativeRead = {
    ...nativeRead,
    description: nativeRead.description + " Successful text reads register this file version for edit; reading every range permits a complete rewrite with write.",
    async execute(id, input, signal, onUpdate, ctx) {
      const epoch = store.epoch;
      active(epoch, signal);
      let image = false;
      let captured: { snapshot: FileSnapshot; token: ObservationToken } | undefined;
      const operations: ReadOperations = {
        async access(path) {
          if (!await files.target(path)) throw new Error("File not found: " + path);
          await files.io.access(path);
        },
        async detectImageMimeType(path) {
          const mime = await detectSupportedImageMimeTypeFromFile(path);
          image = mime !== null;
          return mime;
        },
        async readFile(path) {
          const target = await files.target(path);
          active(epoch, signal);
          if (!target) throw new Error("File not found: " + path);
          const token = store.token(target.key);
          if (image) return files.io.readFile(target.physical);
          const snapshot = await files.read(target);
          active(epoch, signal);
          captured = { snapshot, token };
          return snapshot.bytes;
        },
      };
      const delegate = createReadToolDefinition(ctx?.cwd ?? cwd, { operations });
      const result = await delegate.execute(id, input, signal, onUpdate, ctx);
      active(epoch, signal);
      if (!result.isError && !image && captured && !result.content.some(item => item.type === "image")) {
        const coverage = readCoverage(captured.snapshot.text, input, result.details?.truncation);
        if (coverage) store.recordRead(captured.token, captured.snapshot.hash, coverage.total, coverage.range);
      }
      return result;
    },
  };

  const edit: typeof nativeEdit = {
    ...nativeEdit,
    description: "Edit a file version previously read in this session. A partial read is sufficient; this is a file-version guard, not a target-line guard. " +
      "All edits[].oldText must identify unique, non-overlapping regions of the original file. Exact matching is preferred; only CRLF/LF and ASCII trailing spaces/tabs are tolerated. " +
      "If the file changed or reading state was reset, read it again. Successful edits carry reading state forward.",
    promptGuidelines: [
      "Use read before edit. A successful partial read permits editing that exact file version; grep and shell reads do not.",
      "Use one edit call for multiple disjoint changes. All oldText values address the same original file; merge overlapping changes.",
      "Copy accurate oldText from source. Unicode characters, quotes, dashes and indentation are not folded.",
      "When a file version is stale or reading state was cleared, read the file again before retrying.",
    ],
    renderShell: "default",
    renderCall: renderEditCall,
    async execute(_id, input: EditToolInput, signal, _onUpdate, ctx) {
      const epoch = store.epoch;
      active(epoch, signal);
      if (typeof input?.path !== "string" || !input.path) throw new Error("path must be a non-empty string.");
      const path = resolveToolPath(input.path, ctx?.cwd ?? cwd);
      return withFileMutationQueue(path, async () => {
        active(epoch, signal);
        const before = await files.snapshot(path);
        active(epoch, signal);
        if (!before) throw new Error("File not found: " + input.path + ". Use write to create a new file.");
        const observed = store.require(before.key, before.hash, input.path, false);
        const plan = planEdits(before.text, input.edits, input.path);
        const intended = encodeUtf8(applyTransforms(path, plan.content, transforms));
        if (intended.equals(before.bytes)) throw new Error("No changes made to " + input.path + ". Supply a content-changing edit.");
        active(epoch, signal);
        store.invalidate(before.key, epoch);
        let committed = false;
        try {
          const after = await files.commit(path, before, intended, () => active(epoch, signal));
          committed = true;
          const diff = generateDiffString(before.text, after.text);
          const patch = generateUnifiedPatch(input.path, before.text, after.text);
          active(epoch, signal);
          store.recordMutation(epoch, after.key, after.hash, observed.full);
          return {
            content: [{ type: "text" as const, text: "Successfully replaced " + input.edits.length + " block(s) in " + input.path + "." +
              (plan.usedWhitespaceMatch ? " Matched using line-ending/trailing-whitespace tolerance." : "") }],
            details: { diff: diff.diff, patch, firstChangedLine: diff.firstChangedLine },
          };
        } catch (error) {
          store.invalidate(before.key, epoch);
          if (committed) throw uncertainWrite(input.path, error);
          throw error;
        }
      });
    },
  };

  const write: typeof nativeWrite = {
    ...nativeWrite,
    description: nativeWrite.description + " Creating a new file is allowed directly. Overwriting an existing file requires read to have displayed all ranges of its current version. Successful writes register the actual new version as fully known.",
    promptGuidelines: [
      ...(nativeWrite.promptGuidelines ?? []),
      "Before overwriting an existing file, read its entire current version, paging with offset/limit as needed. A partial read permits edit, not write.",
      "After successful write, the new version is known; edit or write may continue without another read. If the file changes externally, read again.",
    ],
    async execute(id, input, signal, onUpdate, ctx) {
      const epoch = store.epoch;
      active(epoch, signal);
      let touchedKey: string | undefined;
      let committed = false;
      const operations: WriteOperations = {
        mkdir: (path) => files.io.mkdir(path),
        async writeFile(path, content) {
          active(epoch, signal);
          const before = await files.snapshot(path);
          active(epoch, signal);
          if (before) store.require(before.key, before.hash, input.path, true);
          const bytes = encodeUtf8(applyTransforms(path, content, transforms));
          touchedKey = before?.key ?? await files.newKey(path);
          active(epoch, signal);
          store.invalidate(touchedKey, epoch);
          const after = await files.commit(path, before, bytes, () => active(epoch, signal));
          committed = true;
          active(epoch, signal);
          store.recordMutation(epoch, after.key, after.hash, true);
        },
      };
      try {
        // The native factory owns the queue: operations must not acquire it again.
        return await createWriteToolDefinition(ctx?.cwd ?? cwd, { operations }).execute(id, input, signal, onUpdate, ctx);
      } catch (error) {
        if (touchedKey !== undefined) store.invalidate(touchedKey, epoch);
        if (committed) throw uncertainWrite(input.path, error);
        throw error;
      }
    },
  };
  return { read, edit, write, store };
}
