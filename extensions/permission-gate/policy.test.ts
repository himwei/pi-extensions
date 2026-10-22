import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abbreviatePath,
  buildCommandPreview,
  deletionTargetPath,
  detectDangerousCommand,
  detectDangerousCommandInfo,
  detectSensitiveGlob,
  detectSensitiveShellAccess,
  sensitivePathLabel,
} from "./policy.js";

const cwd = "C:\\fictional-project";

assert.equal(sensitivePathLabel(".env", cwd), ".env");
assert.equal(sensitivePathLabel("config/.env.local", cwd), ".env.local");
assert.equal(sensitivePathLabel("config/.env.production", cwd), ".env.production");
assert.equal(sensitivePathLabel(".env.example", cwd), undefined);
assert.equal(sensitivePathLabel(".env.sample", cwd), undefined);
assert.equal(sensitivePathLabel(".env.template", cwd), undefined);
assert.equal(sensitivePathLabel(".env.dist", cwd), undefined);
assert.equal(sensitivePathLabel("my.env", cwd), undefined);
assert.equal(sensitivePathLabel("C:\\fictional-project\\auth.json", cwd), "auth.json");
assert.equal(sensitivePathLabel("C:\\fictional-project\\my-auth.json", cwd), undefined);

const linkDir = mkdtempSync(join(tmpdir(), "pi-policy-test-"));
try {
  const secretPath = join(linkDir, ".env.local");
  const aliasPath = join(linkDir, "visible.txt");
  writeFileSync(secretPath, "placeholder");
  try {
    symlinkSync(secretPath, aliasPath, "file");
    assert.equal(sensitivePathLabel(aliasPath, linkDir), ".env.local");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    console.log("symbolic-link test skipped: no permission to create links");
  }
} finally {
  rmSync(linkDir, { recursive: true, force: true });
}

assert.equal(detectSensitiveShellAccess("Get-Content C:\\fictional-project\\.env"), ".env");
assert.equal(detectSensitiveShellAccess("Set-Content .env.local -Value placeholder"), ".env.local");
assert.equal(detectSensitiveShellAccess("echo placeholder > .env"), ".env");
assert.equal(detectSensitiveShellAccess("Get-Content .env.example"), undefined);
assert.equal(detectSensitiveShellAccess('Write-Output "See .env in the documentation"'), undefined);
assert.equal(detectSensitiveShellAccess('rg -g "!.env" placeholder .'), undefined);
assert.equal(detectSensitiveShellAccess("rg -n '\\.env' src"), undefined);
assert.equal(detectSensitiveShellAccess('rg -g "*.env*" placeholder .'), ".env");
assert.equal(detectSensitiveShellAccess("node script-that-builds-a-path.js"), undefined);
assert.equal(detectSensitiveShellAccess("Get-Content C:\\fictional-project\\auth.json"), "auth.json");
assert.equal(detectSensitiveShellAccess('Write-Output "auth.json is protected"'), undefined);

assert.equal(detectSensitiveGlob("!.env"), undefined);
assert.equal(detectSensitiveGlob("**/.env.example"), undefined);
assert.equal(detectSensitiveGlob("**/.env.local"), ".env.local");
assert.equal(detectSensitiveGlob("**/auth.json"), "auth.json");

assert.equal(detectDangerousCommand("Remove-Item .\\build -Recurse -Force"), "recursive deletion");
assert.equal(detectDangerousCommand("rmdir .\\build -Recurse"), "recursive deletion");
assert.equal(detectDangerousCommand("rd .\\build -Recurse"), "recursive deletion");
assert.equal(detectDangerousCommand("rmdir .\\build\\* -Force"), "forced wildcard deletion");
assert.equal(detectSensitiveShellAccess("rmdir .env.local -Recurse"), ".env.local");
assert.equal(detectDangerousCommand("cmd /c del /s /q .\\build\\*"), "cmd recursive file deletion");
assert.equal(detectDangerousCommand("git reset --hard HEAD"), "Git hard reset");
assert.equal(detectDangerousCommand("Get-ChildItem .\\build"), undefined);

// 规则元数据：中文标签 / 严重度 / 高亮区间 / 目标提取标记
const recursive = detectDangerousCommandInfo("Remove-Item .\\build -Recurse -Force");
assert.ok(recursive);
assert.equal(recursive!.zh, "递归删除");
assert.equal(recursive!.severity, "high");
assert.equal(recursive!.extractTarget, true);
assert.equal(recursive!.index, 0);
assert.ok(recursive!.end > 20, "danger span covers the matched fragment");
assert.ok("Remove-Item .\\build -Recurse".startsWith("Remove-Item"));

const gitInfo = detectDangerousCommandInfo("git reset --hard HEAD");
assert.ok(gitInfo);
assert.equal(gitInfo!.zh, "Git 强制重置");
assert.equal(gitInfo!.severity, "medium");
assert.equal(gitInfo!.extractTarget, false);
assert.ok("git reset --hard HEAD".slice(gitInfo!.index, gitInfo!.end).includes("--hard"));
assert.equal(detectDangerousCommandInfo("Get-ChildItem .\\build"), undefined);

// 预览模型：行数上限、首尾空行丢弃、行内偏移保留（用于高亮求交）
const capped = buildCommandPreview("a\nb\nc\nd");
assert.equal(capped.lines.length, 3);
assert.equal(capped.totalLines, 4);
assert.equal(capped.truncated, true);
assert.equal(capped.multi, true);
assert.deepEqual(capped.lines.map((l) => l.text), ["a", "b", "c"]);

const padded = buildCommandPreview("\n\n  x  \n\n");
assert.equal(padded.lines.length, 1);
assert.equal(padded.totalLines, 1);
assert.equal(padded.multi, false);
assert.equal(padded.truncated, false);
assert.equal(padded.lines[0]!.text, "  x");
assert.equal(padded.lines[0]!.start, 2);
assert.equal(padded.lines[0]!.end, 5);

const crlf = buildCommandPreview("ab\r\ncd");
assert.equal(crlf.lines[1]!.start, 4);
assert.equal(crlf.lines[1]!.text, "cd");
assert.equal(crlf.lines[1]!.end, 6);

// 目标路径提取：跳过旗标/变量，按 cwd 解析；找不到可信目标则省略
assert.equal(deletionTargetPath("Remove-Item -LiteralPath C:\\t\\node_modules -Recurse -Force", cwd), "C:\\t\\node_modules");
assert.equal(deletionTargetPath("rm -rf build", cwd), `${cwd}\\build`);
assert.equal(deletionTargetPath("cmd /c del /s /q .\\build\\*", cwd), `${cwd}\\build\\*`);
assert.equal(deletionTargetPath("git reset --hard HEAD", cwd), undefined);
assert.equal(deletionTargetPath("Get-ChildItem build | Remove-Item -Recurse", cwd), undefined);
assert.equal(deletionTargetPath("rm -rf build", undefined), undefined);

// 回归：目标提取宁缺毋滥——脚本结构碎片（};）、语句边界、破碎的引号/变量参数一律不显示
assert.equal(
  deletionTargetPath("if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }; cleanup", cwd),
  undefined,
);
assert.equal(deletionTargetPath('Remove-Item -Recurse -Force "C:\\data\\old build"', cwd), undefined);
assert.equal(deletionTargetPath("Remove-Item -Recurse .\\build; echo done", cwd), undefined);

// 路径缩略：保头保尾，总长不变
const long = `C:\\${"x".repeat(60)}`;
const shortPath = abbreviatePath(long, 48);
assert.equal(shortPath.length, 48);
assert.ok(shortPath.includes("…"));
assert.equal(abbreviatePath("C:\\short", 48), "C:\\short");

console.log("permission-gate policy tests passed");
