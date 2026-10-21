import assert from "node:assert/strict";
import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createEditToolDefinition, generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import factory from "../write-transforms.js";
import permissionGate from "../permission-gate.js";
import { FileAccess, decodeUtf8, encodeUtf8, hashBytes, localFileIO, pathKey, resolveToolPath, type FileIO } from "./files.js";
import { ObservationStore } from "./observations.js";
import { createEnhancedTools, readCoverage, type EnhancedToolOptions } from "./tools.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let serial = 0;
function harness(cwd: string, options: EnhancedToolOptions = {}) {
  const tools = createEnhancedTools(cwd, options);
  const ctx: any = { cwd, hasUI: false, mode: "print" };
  const call = async (name: "read" | "edit" | "write", input: any, signal?: AbortSignal): Promise<any> => {
    const tool = tools[name];
    const args = tool.prepareArguments?.(input) ?? input;
    return tool.execute("test-" + ++serial, args as never, signal, undefined, ctx);
  };
  ctx.executeTool = (name: "read" | "edit" | "write", input: any) => call(name, input);
  return { ...tools, ctx, call };
}

const change = (path: string, oldText: string, newText: string) => ({ path, edits: [{ oldText, newText }] });
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const fixture = (base: string, name: string, options?: EnhancedToolOptions) => harness(join(base, name), options);

function pixelPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const block = Buffer.alloc(data.length + 12);
    block.writeUInt32BE(data.length, 0);
    payload.copy(block, 4);
    block.writeUInt32BE((crc ^ 0xffffffff) >>> 0, block.length - 4);
    return block;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-edit-harness-"));
  try {
    // Pi's public schema, argument adapters and native result renderer remain reusable.
    {
      const h = harness(dir);
      const native = createEditToolDefinition(dir);
      assert.deepEqual(h.edit.parameters, native.parameters);
      assert.equal(h.edit.prepareArguments, native.prepareArguments);
      assert.equal(h.edit.renderResult, native.renderResult);
      assert.equal(h.edit.renderShell, "default");
      const path = join(dir, "unread.txt");
      await writeFile(path, "first\nsecond\n");
      await assert.rejects(() => h.call("edit", change(path, "second", "changed")), /Read required/);
      await assert.rejects(() => h.call("write", { path, content: "lost" }), /Read required/);
      assert.equal(await readFile(path, "utf8"), "first\nsecond\n");
      const read = await h.call("read", { path, offset: 1, limit: 1 });
      assert.equal(read.structuredContent, text(read), "native structured content is retained");
      await assert.rejects(() => h.call("write", { path, content: "lost" }), /Full read required/);
      await h.call("edit", change(path, "second", "changed"));
      await h.call("edit", change(path, "changed", "again"));
      await assert.rejects(() => h.call("write", { path, content: "lost" }), /Full read required/);
      await h.call("read", { path, offset: 2, limit: 1 });
      await assert.rejects(() => h.call("write", { path, content: "lost" }), /Full read required/, "old partial ranges reset after edits");
      await h.call("read", { path, offset: 1, limit: 1 });
      await h.call("write", { path, content: "full rewrite" });
      await h.call("write", { path, content: "second rewrite" });
      await h.call("edit", change(path, "second", "third"));
      assert.equal(await readFile(path, "utf8"), "third rewrite");
    }

    // Existing BOM and mixed newlines survive. New files are fully known.
    {
      const h = harness(dir);
      const path = join(dir, "中文.ps1");
      await h.call("write", { path, content: "# 中文\n$x=1\n" });
      assert.notDeepEqual([...((await readFile(path)).subarray(0, 3))], [239, 187, 191]);
      await h.call("edit", change(path, "$x=1", "$x=2"));
      const bom = join(dir, "bom.txt");
      await writeFile(bom, "\uFEFFＡ a=1 \t\r\nb\t\n");
      await h.call("read", { path: bom });
      const result = await h.call("edit", change(bom, "a=1\n", "a=2\n"));
      assert.equal(await readFile(bom, "utf8"), "\uFEFFＡ a=2\r\nb\t\n");
      assert.equal(result.details.patch, generateUnifiedPatch(bom, "\uFEFFＡ a=1 \t\r\nb\t\n", "\uFEFFＡ a=2\r\nb\t\n"));
      // Pi's legacy argument preparation remains available before schema validation.
      await h.call("edit", { path: bom, oldText: "a=2", newText: "a=3" });
      await h.call("edit", { path: bom, edits: JSON.stringify([{ oldText: "a=3", newText: "a=4" }]) });
      assert.match(await readFile(bom, "utf8"), /a=4/);
    }

    // Pagination, blank rows and truncation never earn unshown coverage.
    {
      const h = harness(dir);
      const path = join(dir, "large.txt");
      const source = Array.from({ length: 2003 }, (_, index) => "row-" + index).join("\n");
      await writeFile(path, source);
      const first = await h.call("read", { path });
      assert.equal(first.details.truncation.outputLines, 2000);
      await assert.rejects(() => h.call("write", { path, content: "no" }), /Full read required/);
      await h.call("read", { path, offset: 2001 });
      await h.call("write", { path, content: "complete" });
      const blanks = join(dir, "blanks.txt");
      await writeFile(blanks, "a\n\nb\n");
      await h.call("read", { path: blanks, limit: 2 });
      await h.call("read", { path: blanks, offset: 3, limit: 1 });
      await h.call("write", { path: blanks, content: "all rows read" });
      const wide = join(dir, "wide.txt");
      await writeFile(wide, "a".repeat(60_000));
      const wideRead = await h.call("read", { path: wide });
      assert.equal(wideRead.details.truncation.firstLineExceedsLimit, true);
      await assert.rejects(() => h.call("edit", change(wide, "aaa", "b")), /Read required/);
      const byteCapped = join(dir, "byte-limit.txt");
      await writeFile(byteCapped, "中".repeat(10_000) + "\n" + "文".repeat(10_000));
      assert.equal((await h.call("read", { path: byteCapped })).details.truncation.truncatedBy, "bytes");
      await assert.rejects(() => h.call("write", { path: byteCapped, content: "no" }), /Full read required/);
      await h.call("read", { path: byteCapped, offset: 2 });
      await h.call("write", { path: byteCapped, content: "yes" });
      const empty = join(dir, "empty.txt");
      await writeFile(empty, "");
      await h.call("read", { path: empty });
      await h.call("write", { path: empty, content: "created from empty" });
      assert.deepEqual(readCoverage("\n\n", { path: "", limit: 1 })?.range, [1, 1]);
      assert.equal(readCoverage("x", { path: "", limit: 0 }), undefined);
    }

    // External changes revoke the old observation; matching failures do not.
    {
      const h = harness(dir);
      const path = join(dir, "external.txt");
      await writeFile(path, "old");
      await h.call("read", { path });
      await writeFile(path, "external");
      await assert.rejects(() => h.call("edit", change(path, "external", "new")), /changed since/);
      await assert.rejects(() => h.call("write", { path, content: "new" }), /Read required/);
      await h.call("read", { path });
      await assert.rejects(() => h.call("edit", change(path, "missing", "new")), /No match/);
      await assert.rejects(() => h.call("edit", change(path, "external", "external")), /No changes/);
      await h.call("edit", change(path, "external", "accepted"));
      assert.equal(await readFile(path, "utf8"), "accepted");
    }

    // Failed or cancelled reads never register a version, even if bytes arrived.
    for (const outcome of ["failed", "aborted"] as const) {
      const path = join(dir, "read-" + outcome + ".txt");
      await writeFile(path, "old");
      const entered = deferred();
      const release = deferred();
      const drained = deferred();
      const controller = new AbortController();
      let intercept = true;
      const io: FileIO = {
        ...localFileIO,
        async readFile(file) {
          const bytes = await localFileIO.readFile(file);
          if (!intercept) return bytes;
          intercept = false;
          entered.resolve();
          await release.promise;
          drained.resolve();
          if (outcome === "failed") throw new Error("read failure");
          return bytes;
        },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      const pending = h.call("read", { path }, controller.signal);
      const rejected = assert.rejects(pending, outcome === "failed" ? /read failure/ : /aborted/);
      await entered.promise;
      if (outcome === "aborted") controller.abort();
      release.resolve();
      await Promise.all([rejected, drained.promise]);
      await new Promise<void>(done => setImmediate(done));
      await assert.rejects(() => h.call("edit", change(path, "old", "new")), /Read required/);
    }

    // Invalid byte sequences and malformed JS Unicode are refused without lossy conversion.
    {
      const h = harness(dir);
      const path = join(dir, "invalid.txt");
      const bytes = Buffer.from([0x61, 0xff, 0x62]);
      await writeFile(path, bytes);
      await assert.rejects(() => h.call("read", { path }), /Invalid UTF-8/);
      await assert.rejects(() => h.call("edit", change(path, "a", "z")), /Invalid UTF-8/);
      await assert.rejects(() => h.call("write", { path, content: "new" }), /Invalid UTF-8/);
      assert.deepEqual(await readFile(path), bytes);
      assert.throws(() => encodeUtf8("\ud800"), /surrogate/);
      assert.equal(decodeUtf8(Buffer.from("\uFEFF中文"), path), "\uFEFF中文");
    }

    // Transform output, not pre-transform text, determines disk bytes, diff and next version.
    {
      const h = harness(dir, { transforms: [{ name: "token", applies: () => true, transform: (_path, value) => value.replaceAll("token", "TOKEN") }] });
      const path = join(dir, "transform.txt");
      await writeFile(path, "token x=1\n");
      await h.call("read", { path });
      const result = await h.call("edit", change(path, "x=1", "x=2"));
      const after = "TOKEN x=2\n";
      assert.equal(await readFile(path, "utf8"), after);
      assert.equal(result.details.diff, generateDiffString("token x=1\n", after).diff);
      assert.equal(result.details.patch, generateUnifiedPatch(path, "token x=1\n", after));
      await h.call("edit", change(path, "TOKEN", "DONE"));
      await h.call("write", { path, content: "token z=3" });
      assert.equal(await readFile(path, "utf8"), "TOKEN z=3");
      await h.call("edit", change(path, "z=3", "z=4"));
    }

    // Diff and patch also include byte-affecting BOM/line-ending transforms.
    {
      const before = "\uFEFFa\r\nb\n";
      const after = "a\nb\n";
      const path = join(dir, "format-transform.txt");
      await writeFile(path, before);
      const h = harness(dir, { transforms: [{
        name: "format", applies: () => true,
        transform: () => after,
      }] });
      await h.call("read", { path });
      const result = await h.call("edit", change(path, "a", "A"));
      assert.equal(await readFile(path, "utf8"), after);
      assert.equal(result.details.diff, generateDiffString(before, after).diff);
      assert.equal(result.details.patch, generateUnifiedPatch(path, before, after));
      assert.equal(result.details.firstChangedLine, 1);
    }

    // File changed between planning and commit: fail before overwriting external content.
    {
      const path = join(dir, "prewrite-race.txt");
      await writeFile(path, "old");
      let reads = -100;
      let writes = 0;
      const io: FileIO = {
        ...localFileIO,
        async readFile(file) {
          if (++reads === 2) await writeFile(path, "external");
          return localFileIO.readFile(file);
        },
        async writeFile(file, bytes, flag) { writes++; await localFileIO.writeFile(file, bytes, flag); },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      await h.call("read", { path });
      reads = 0;
      await assert.rejects(() => h.call("edit", change(path, "old", "new")), /changed before writing/);
      assert.equal(writes, 0);
      assert.equal(await readFile(path, "utf8"), "external");
    }

    // Lost writes, partial failures and cancellation revoke authorization and never auto-retry.
    for (const tool of ["edit", "write"] as const) for (const failure of ["unchanged", "partial", "abort"] as const) {
      const path = join(dir, tool + "-" + failure + ".txt");
      await writeFile(path, "old");
      const controller = new AbortController();
      let attempts = 0;
      const io: FileIO = {
        ...localFileIO,
        async writeFile(file, bytes, flag) {
          attempts++;
          if (failure === "unchanged") return;
          if (failure === "partial") { await writeFile(file, "partial"); throw new Error("disk failure"); }
          await localFileIO.writeFile(file, bytes, flag);
          controller.abort();
        },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      await h.call("read", { path });
      await assert.rejects(() => h.call(tool, tool === "edit" ? change(path, "old", "new") : { path, content: "new" }, controller.signal), /may already be on disk/);
      assert.equal(attempts, 1);
      await assert.rejects(() => h.call("edit", change(path, "new", "next")), /Read required/);
      assert.equal(await readFile(path, "utf8"), failure === "unchanged" ? "old" : failure === "partial" ? "partial" : "new");
    }

    // Native write can observe an abort after our write callback has settled.
    {
      const path = join(dir, "post-callback-abort.txt");
      const controller = new AbortController();
      class AbortingStore extends ObservationStore {
        override recordMutation(epoch: number, key: string, hash: string, full: boolean): void {
          super.recordMutation(epoch, key, hash, full);
          controller.abort();
        }
      }
      const h = harness(dir, { store: new AbortingStore() });
      await assert.rejects(() => h.call("write", { path, content: "landed" }, controller.signal), /may already be on disk/);
      assert.equal(await readFile(path, "utf8"), "landed");
      await assert.rejects(() => h.call("edit", change(path, "landed", "next")), /Read required/);
    }

    // An edit aborted immediately after verified commit still reports uncertainty.
    {
      const path = join(dir, "post-commit-abort.txt");
      await writeFile(path, "old");
      const controller = new AbortController();
      class AbortingFiles extends FileAccess {
        override async commit(...args: Parameters<FileAccess["commit"]>) {
          const result = await super.commit(...args);
          controller.abort();
          return result;
        }
      }
      const h = harness(dir, { files: new AbortingFiles() });
      await h.call("read", { path });
      await assert.rejects(() => h.call("edit", change(path, "old", "new"), controller.signal), /may already be on disk/);
      assert.equal(await readFile(path, "utf8"), "new");
      await assert.rejects(() => h.call("edit", change(path, "new", "next")), /Read required/);
    }

    // A file appearing after preflight cannot be clobbered by a "new file" write.
    {
      const path = join(dir, "create-race.txt");
      const io: FileIO = {
        ...localFileIO,
        async writeFile(file, bytes, flag) {
          assert.equal(flag, "wx");
          await writeFile(file, "someone else's file");
          await localFileIO.writeFile(file, bytes, flag);
        },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      await assert.rejects(() => h.call("write", { path, content: "ours" }), /may already be on disk/);
      assert.equal(await readFile(path, "utf8"), "someone else's file");
    }

    // Cancellation keeps Pi's queue held until the started filesystem write settles.
    {
      const path = join(dir, "queue.txt");
      await writeFile(path, "old");
      const entered = deferred();
      const release = deferred();
      let attempts = 0;
      const controller = new AbortController();
      const io: FileIO = {
        ...localFileIO,
        async writeFile(file, bytes, flag) {
          attempts++;
          entered.resolve();
          await release.promise;
          await localFileIO.writeFile(file, bytes, flag);
        },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      await h.call("read", { path });
      const first = h.call("edit", change(path, "old", "new"), controller.signal);
      const firstRejected = assert.rejects(first, /may already be on disk/);
      await entered.promise;
      let secondFinished = false;
      const second = h.call("write", { path, content: "overwrite" }).finally(() => { secondFinished = true; });
      const secondRejected = assert.rejects(second, /Read required/);
      controller.abort();
      await new Promise<void>(done => setImmediate(done));
      assert.equal(secondFinished, false);
      release.resolve();
      await Promise.all([firstRejected, secondRejected]);
      assert.equal(attempts, 1);
      assert.equal(await readFile(path, "utf8"), "new");
    }

    // Generation guards: delayed reads cannot refill cleared or superseded records.
    for (const reset of ["clear", "mutation"] as const) {
      const path = join(dir, "late-" + reset + ".txt");
      await writeFile(path, "old");
      const captured = deferred();
      const release = deferred();
      let pause = false;
      const io: FileIO = {
        ...localFileIO,
        async readFile(file) {
          const bytes = await localFileIO.readFile(file);
          if (pause) { pause = false; captured.resolve(); await release.promise; }
          return bytes;
        },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      await h.call("read", { path });
      pause = true;
      const pending = h.call("read", { path });
      const settled = reset === "clear" ? assert.rejects(pending, /reading state changed/) : pending;
      await captured.promise;
      if (reset === "clear") h.store.clear();
      else await h.call("write", { path, content: "new" });
      release.resolve();
      await settled;
      if (reset === "clear") await assert.rejects(() => h.call("edit", change(path, "old", "next")), /Read required/);
      else await h.call("edit", change(path, "new", "next"));
    }

    // A late failure in a retired session must not revoke a new-session read.
    {
      const path = join(dir, "late-failure.txt");
      await writeFile(path, "old");
      const entered = deferred();
      const release = deferred();
      let intercept = true;
      const io: FileIO = {
        ...localFileIO,
        async writeFile(file, bytes, flag) {
          if (intercept) {
            intercept = false;
            entered.resolve();
            await release.promise;
            throw new Error("late disk failure");
          }
          await localFileIO.writeFile(file, bytes, flag);
        },
      };
      const h = harness(dir, { files: new FileAccess(io) });
      await h.call("read", { path });
      const rejected = assert.rejects(h.call("edit", change(path, "old", "new")), /may already be on disk/);
      await entered.promise;
      h.store.clear();
      await h.call("read", { path });
      release.resolve();
      await rejected;
      await h.call("edit", change(path, "old", "new"));
      assert.equal(await readFile(path, "utf8"), "new");
    }

    // Lifecycle hooks clear state, but compaction failure does not clear it.
    {
      const registered = new Map<string, any>();
      const handlers = new Map<string, any>();
      factory({
        on: (name: string, handler: any) => handlers.set(name, handler),
        registerTool: (tool: any) => registered.set(tool.name, tool),
      } as any);
      const ctx: any = { cwd: dir, hasUI: false, mode: "print" };
      handlers.get("session_start")({ reason: "startup" }, ctx);
      const execute = (name: string, args: any) => registered.get(name).execute("lifecycle", args, undefined, undefined, ctx);
      const path = join(dir, "lifecycle.txt");
      await writeFile(path, "old");
      for (const name of ["session_tree", "session_compact", "session_shutdown", "session_start"]) {
        await execute("read", { path });
        handlers.get(name)({}, ctx);
        await assert.rejects(() => execute("edit", change(path, "old", "new")), /Read required/);
      }
      assert.equal(handlers.has("session_compact_failed"), false);
      await execute("read", { path });
      await execute("edit", change(path, "old", "new"));
    }

    // Text observations are per invocation; nested and concurrent reads share the same store.
    {
      const h = fixture(dir, "nested");
      await h.call("write", { path: "a.txt", content: "a" });
      await h.call("write", { path: "b.txt", content: "b" });
      h.store.clear();
      await Promise.all([h.ctx.executeTool("read", { path: "a.txt" }), h.ctx.executeTool("read", { path: "b.txt" })]);
      await h.ctx.executeTool("edit", change("a.txt", "a", "A"));
      await h.ctx.executeTool("edit", change("b.txt", "b", "B"));
      assert.equal(await readFile(join(dir, "nested", "a.txt"), "utf8"), "A");
      assert.equal(await readFile(join(dir, "nested", "b.txt"), "utf8"), "B");
    }

    // Image handling stays native and does not count as a successful text read.
    {
      const h = harness(dir);
      const path = join(dir, "pixel.png");
      const png = pixelPng();
      await writeFile(path, png);
      const result = await h.call("read", { path });
      assert.ok(result.content.some((part: any) => part.type === "image"), text(result));
      assert.equal(result.structuredContent.type, "image");
      const key = pathKey(await realpath(path));
      assert.throws(() => h.store.require(key, hashBytes(png), path, false), /Read required/);
      assert.deepEqual(await readFile(path), png);
    }

    // In-place writes keep hard links; symlink paths observe the canonical target.
    {
      const h = harness(dir);
      const original = join(dir, "linked.txt");
      const hard = join(dir, "hardlink.txt");
      await writeFile(original, "long original");
      await link(original, hard);
      await h.call("read", { path: original });
      await h.call("write", { path: original, content: "short" });
      assert.equal(await readFile(hard, "utf8"), "short");
      if (process.platform === "win32") {
        const targetDir = join(dir, "link-target");
        await localFileIO.mkdir(targetDir);
        const junction = join(dir, "junction");
        await symlink(targetDir, junction, "junction");
        await writeFile(join(targetDir, "file.txt"), "old");
        await h.call("read", { path: join(junction, "file.txt") });
        await h.call("edit", change(join(targetDir, "file.txt"), "old", "new"));
        assert.equal(await readFile(join(junction, "file.txt"), "utf8"), "new");
      }
    }

    // Existing credential gate still sees the same tool names and path schema.
    {
      const handlers = new Map<string, any>();
      permissionGate({ on: (name: string, fn: any) => handlers.set(name, fn) } as any);
      for (const name of ["read", "edit", "write"]) {
        const decision = await handlers.get("tool_call")({
          type: "tool_call", toolName: name, toolCallId: "gate", input: { path: join(dir, ".env") },
        }, { cwd: dir, hasUI: false });
        assert.equal(decision.block, true);
      }
    }

    assert.equal(resolveToolPath("@./a.txt", dir), join(dir, "a.txt"));
    const key = pathKey(await realpath(dir));
    const store = new ObservationStore();
    const oldToken = store.token(key);
    store.clear();
    store.invalidate(key, oldToken.epoch);
    const token = store.token(key);
    store.recordRead(token, "hash", 1, [1, 1]);
    store.recordRead(oldToken, "old", 1, [1, 1]);
    assert.equal(store.require(key, "hash", key, true).full, true);
    console.log("write-transforms harness tests passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
