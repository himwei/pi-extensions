import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type FileStat = Pick<Stats, "isFile" | "dev" | "ino">;
export interface FileIO {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, bytes: Buffer, flag: "r+" | "wx"): Promise<void>;
  mkdir(path: string): Promise<void>;
  access(path: string): Promise<void>;
}

export const localFileIO: FileIO = {
  realpath, stat, lstat, readFile,
  access: (path) => access(path, constants.R_OK),
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => {}),
  async writeFile(path, bytes, flag) {
    // r+ preserves the inode, ACLs, symlinks and hard links and cannot recreate a deleted target.
    const handle = await open(path, flag);
    try {
      await handle.writeFile(bytes);
      if (flag === "r+") await handle.truncate(bytes.length);
    } finally {
      await handle.close();
    }
  },
};

export interface FileTarget {
  requested: string;
  physical: string;
  key: string;
  identity: string;
}
export interface FileSnapshot extends FileTarget { bytes: Buffer; hash: string; text: string }

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Mirrors Pi's local tool path conveniences without importing private modules. */
export function resolveToolPath(input: string, cwd: string): string {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32" && !path.includes("\\") && !path.startsWith("//")) {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_all, drive: string, suffix: string | undefined) => drive.toUpperCase() + ":\\" + (suffix ?? "").replaceAll("/", "\\"));
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(cwd, path);
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Invalid UTF-8 in " + path + ". Convert the file explicitly before editing; no replacement characters were written.");
  }
}

export function encodeUtf8(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text) throw new Error("Content contains an invalid Unicode surrogate. Correct the replacement text before writing.");
  return bytes;
}

export function uncertainWrite(path: string, error: unknown): Error {
  return new Error("Write failed or was cancelled for " + path +
    "; changes may already be on disk. Read the file again before retrying. " +
    (error instanceof Error ? error.message : String(error)));
}

export class FileAccess {
  constructor(readonly io: FileIO = localFileIO) {}

  async target(path: string): Promise<FileTarget | undefined> {
    let physical: string;
    try { physical = await this.io.realpath(path); }
    catch (error) {
      if (!isMissing(error)) throw error;
      // A dangling symlink is not an absent file eligible for creation.
      try { await this.io.lstat(path); }
      catch (missing) { if (isMissing(missing)) return undefined; throw missing; }
      throw new Error("Cannot modify a dangling link: " + path);
    }
    const info = await this.io.stat(physical);
    if (!info.isFile()) throw new Error("Not a regular file: " + path);
    return { requested: path, physical, key: pathKey(physical), identity: String(info.dev) + ":" + String(info.ino) };
  }

  async read(target: FileTarget): Promise<FileSnapshot> {
    const bytes = await this.io.readFile(target.physical);
    return { ...target, bytes, hash: hashBytes(bytes), text: decodeUtf8(bytes, target.requested) };
  }

  async snapshot(path: string): Promise<FileSnapshot | undefined> {
    const target = await this.target(path);
    return target ? this.read(target) : undefined;
  }

  async newKey(path: string): Promise<string> {
    return pathKey(join(await this.io.realpath(dirname(path)), basename(path)));
  }

  async commit(
    path: string, before: FileSnapshot | undefined, bytes: Buffer, assertActive: () => void,
  ): Promise<FileSnapshot> {
    const fresh = await this.snapshot(path);
    assertActive();
    if (before ? (!fresh || fresh.key !== before.key || fresh.identity !== before.identity || fresh.hash !== before.hash) : fresh !== undefined) {
      throw new Error("File changed before writing " + path + ". Read its current version and retry.");
    }
    try {
      // No await between the last cancellation check and starting the write.
      await this.io.writeFile(before?.physical ?? path, bytes, before ? "r+" : "wx");
      const after = await this.snapshot(path);
      if (!after || (before && (after.key !== before.key || after.identity !== before.identity)) || !after.bytes.equals(bytes)) {
        throw new Error("Written content could not be verified.");
      }
      assertActive();
      return after;
    } catch (error) {
      throw uncertainWrite(path, error);
    }
  }
}
