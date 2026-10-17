import { basename, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/** Rule severity drives dialog color and icon; both levels still require explicit approval. */
export type GateSeverity = "high" | "medium";

export interface DangerousCommandInfo {
  label: string;
  /** Chinese label shown in the dialog title. */
  zh: string;
  severity: GateSeverity;
  /** One-line consequence shown under the command. */
  consequence: string;
  /** First match span (offsets into the command) highlighted in the preview. */
  index: number;
  end: number;
  /** Whether a filesystem target may be extractable for the info line. */
  extractTarget: boolean;
}

interface DangerousRule {
  label: string;
  zh: string;
  severity: GateSeverity;
  consequence: string;
  /** Extract the deletion target for the info line when this rule matches. */
  extractTarget?: boolean;
  pattern: RegExp;
}

const DELETION_CONSEQUENCE = "目录及全部内容将被永久删除，回收站不保留，不可撤销";

const DANGEROUS_COMMAND_RULES: DangerousRule[] = [
  { label: "recursive deletion", zh: "递归删除", severity: "high", consequence: DELETION_CONSEQUENCE, extractTarget: true,
    pattern: /\b(?:remove-item|rm|ri|rmdir|rd|del|erase)\b[\s\S]*\s-(?:recurse|r)\b/i },
  { label: "forced wildcard deletion", zh: "强制通配符删除", severity: "high",
    consequence: "通配符匹配的所有文件将被强制删除（含只读/隐藏），不可撤销",
    pattern: /\b(?:remove-item|rm|ri|rmdir|rd|del|erase)\b[\s\S]*(?:\*|\?)[\s\S]*\s-force\b/i },
  { label: "cmd recursive deletion", zh: "cmd 递归删除", severity: "high", consequence: DELETION_CONSEQUENCE, extractTarget: true,
    pattern: /\b(?:cmd(?:\.exe)?\s+\/c\s+)?(?:rd|rmdir)\b[\s\S]*\/(?:s|q)\b/i },
  // cmd `del /s`: require the /s flag to stand alone so Windows paths like `C:/src` don't match.
  { label: "cmd recursive file deletion", zh: "cmd 递归文件删除", severity: "high", consequence: DELETION_CONSEQUENCE, extractTarget: true,
    pattern: /\b(?:cmd(?:\.exe)?\s+\/c\s+)?del\b[\s\S]*\/s(?![\w])/i },
  { label: "Unix recursive deletion", zh: "rm 递归删除", severity: "high", consequence: DELETION_CONSEQUENCE, extractTarget: true,
    pattern: /\brm\s+(?:-[a-z]*r[a-z]*f?|--recursive)\b/i },
  { label: "Git clean", zh: "Git 清理", severity: "medium",
    consequence: "未跟踪的文件/目录将被删除（-x 连已忽略文件也删），不可撤销",
    pattern: /\bgit\s+clean\b[\s\S]*-[a-z]*f/i },
  { label: "Git hard reset", zh: "Git 强制重置", severity: "medium",
    consequence: "未提交的修改与暂存内容将被永久丢弃，不可撤销",
    pattern: /\bgit\s+reset\b[\s\S]*--hard\b/i },
  { label: "Python recursive deletion", zh: "shutil.rmtree 递归删除", severity: "high", consequence: DELETION_CONSEQUENCE,
    pattern: /\bshutil\s*\.\s*rmtree\s*\(/i },
  { label: "disk formatting", zh: "磁盘格式化", severity: "high",
    consequence: "磁盘/分区将被清空，所有数据不可恢复",
    pattern: /\b(?:format-volume|clear-disk|remove-partition|diskpart)\b/i },
];

/** Exact basenames that must never be read/written/edited by model tools. */
const SENSITIVE_BASENAMES = new Set(["auth.json"]);

/** Safe templates are useful project documentation, not runtime credentials. */
const SAFE_ENV_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
]);

const SENSITIVE_SHELL_OPERATIONS = /\b(?:get-content|gc|cat|type|more|select-string|sls|rg|grep|findstr|set-content|sc|out-file|add-content|ac|remove-item|ri|rmdir|rd|del|erase|rm|copy-item|cp|copy|move-item|mv|move|open|read_text|read_bytes|write_text|write_bytes|readFile|writeFile|ReadAllText|ReadAllBytes|WriteAllText|WriteAllBytes)\b/i;
const REDIRECTION = /(?:^|\s)(?:\d?>|<)\s*/;

/**
 * Find path-like occurrences without treating ordinary names such as `my.env`
 * or `my-auth.json` as the protected basenames.
 */
const ENV_REFERENCE = /(?<![\w.-])(?:(?:[A-Za-z]:|~|\.{1,2})[\\/]|[\w .-]+[\\/])*\.env(?:\.[\w.-]+)?/gi;
const AUTH_REFERENCE = /(?<![\w.-])(?:(?:[A-Za-z]:|~|\.{1,2})[\\/]|[\w .-]+[\\/])*auth\.json(?![\w.-])/gi;

export function detectDangerousCommandInfo(command: string): DangerousCommandInfo | undefined {
  for (const rule of DANGEROUS_COMMAND_RULES) {
    const match = rule.pattern.exec(command);
    if (!match) continue;
    const index = match.index ?? 0;
    return {
      label: rule.label,
      zh: rule.zh,
      severity: rule.severity,
      consequence: rule.consequence,
      index,
      end: index + match[0].length,
      extractTarget: rule.extractTarget === true,
    };
  }
  return undefined;
}

export function detectDangerousCommand(command: string): string | undefined {
  return detectDangerousCommandInfo(command)?.label;
}

// ---------- 确认框预览模型 ----------

export interface CommandPreviewLine {
  text: string;
  /** Offsets into the original command, so a danger span can be intersected per line. */
  start: number;
  end: number;
}

export interface CommandPreview {
  lines: CommandPreviewLine[];
  totalLines: number;
  bytes: number;
  truncated: boolean;
  multi: boolean;
}

/** Keep at most `maxLines` lines (leading/trailing blank lines dropped); the info line
 * carries the full line/byte count instead of growing the dialog. */
export function buildCommandPreview(command: string, maxLines = 3): CommandPreview {
  const rawLines: Array<{ text: string; start: number }> = [];
  let offset = 0;
  for (const raw of command.split("\n")) {
    const text = raw.replace(/\r$/, "").replace(/\s+$/, "");
    rawLines.push({ text, start: offset });
    offset += raw.length + 1;
  }
  let first = 0;
  let last = rawLines.length - 1;
  while (first <= last && rawLines[first]!.text === "") first++;
  while (last >= first && rawLines[last]!.text === "") last--;
  const kept = rawLines.slice(first, last + 1);
  const shown = kept.slice(0, Math.max(1, maxLines));
  return {
    lines: shown.map((line) => ({ text: line.text, start: line.start, end: line.start + line.text.length })),
    totalLines: kept.length,
    bytes: Buffer.byteLength(command, "utf8"),
    truncated: kept.length > shown.length,
    multi: kept.length > 1,
  };
}

// ---------- 目标路径提取（信息行用，仅启发式） ----------

const DELETION_VERB = /^(?:remove-item|ri|rmdir|rd|rm|del|erase)$/i;
/** 路径里不可能出现、或意味着这是一个无法可靠解析的脚本片段（如 `};`、带内嵌引号/变量的参数）。
 * 提示行宁缺毋滥：拿不准就不显示目标，绝不显示错误的目标。 */
const UNSAFE_TARGET_CHARS = /[;{}()|&<>=`"'\$]/;

/** Resolve the first non-flag operand after a deletion verb against `cwd`.
 * Best-effort display hint for the info line; undefined when nothing convincing is found. */
export function deletionTargetPath(command: string, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    const tokens = command.split(/\s+/).filter(Boolean);
    const verbIndex = tokens.findIndex((token) => DELETION_VERB.test(token));
    if (verbIndex === -1) return undefined;
    for (let i = verbIndex + 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (/[;|&]/.test(token)) return undefined; // 语句边界：后面的 token 属于别的命令
      if (token.startsWith("-") || token.startsWith("/")) continue; // flags
      if (UNSAFE_TARGET_CHARS.test(token)) continue; // 脚本结构碎片 / 变量 / 破碎的引号参数
      if (!token) continue;
      return abbreviatePath(resolvePath(token, cwd));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Middle-abbreviate a long absolute path: keep the head and the discriminating tail. */
export function abbreviatePath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const head = path.slice(0, 14);
  const tail = path.slice(Math.max(head.length + 1, path.length - (max - head.length - 1)));
  return `${head}…${tail}`;
}

function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

function resolvePath(path: string, cwd: string): string {
  const expanded = expandHome(path.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isEnvBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || (lower.startsWith(".env.") && !SAFE_ENV_BASENAMES.has(lower));
}

export function sensitivePathLabel(path: string, cwd: string): string | undefined {
  if (!path.trim()) return undefined;

  try {
    const abs = resolvePath(path, cwd);
    const name = basename(abs);
    const lower = name.toLowerCase();
    if (SENSITIVE_BASENAMES.has(lower) || isEnvBasename(name)) return name;

    // Resolve existing symbolic links for file tools; missing targets are checked by name only.
    const actualName = basename(realpathSync.native(abs));
    if (SENSITIVE_BASENAMES.has(actualName.toLowerCase()) || isEnvBasename(actualName)) {
      return actualName;
    }
  } catch {
    // Fall through to basename-only checks on missing or unresolvable inputs.
  }

  const rawName = basename(expandHome(path.trim()));
  if (SENSITIVE_BASENAMES.has(rawName.toLowerCase()) || isEnvBasename(rawName)) {
    return rawName;
  }
  return undefined;
}

function labelForReference(reference: string): string | undefined {
  const name = basename(reference);
  if (SENSITIVE_BASENAMES.has(name.toLowerCase())) return name;
  if (isEnvBasename(name)) return name;
  return undefined;
}

function findSensitiveReference(command: string): string | undefined {
  for (const pattern of [ENV_REFERENCE, AUTH_REFERENCE]) {
    pattern.lastIndex = 0;
    for (const match of command.matchAll(pattern)) {
      const index = match.index ?? 0;
      const previous = command[index - 1];
      const beforePrevious = command[index - 2];

      // An explicitly excluded ripgrep glob such as `!.env` does not target the file.
      if (previous === "!") continue;
      // Do not treat an escaped dot in a search expression such as `\\.env` as a path.
      if (previous === "\\" && (beforePrevious === "'" || beforePrevious === '"')) continue;

      const label = labelForReference(match[0]);
      if (label) return label;
    }
  }
  return undefined;
}

/**
 * Detect high-confidence shell access to a protected path.
 * Merely mentioning a filename in prose, documentation, or an exclusion glob
 * is allowed. Shell indirection and encoded scripts remain outside this heuristic.
 */
export function detectSensitiveShellAccess(command: string): string | undefined {
  if (!SENSITIVE_SHELL_OPERATIONS.test(command) && !REDIRECTION.test(command)) {
    return undefined;
  }
  return findSensitiveReference(command);
}

/** Used by grep's glob argument, where the glob itself is the target selector. */
export function detectSensitiveGlob(glob: string): string | undefined {
  return findSensitiveReference(glob);
}
