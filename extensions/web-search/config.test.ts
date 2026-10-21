import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigEnvFile, resolveCredentials } from "./client.js";
import { detectSensitiveShellAccess, sensitivePathLabel } from "../permission-gate/policy.js";

const root = mkdtempSync(join(tmpdir(), "pi-search-config-"));
const user = join(root, "user.env");
const legacy = join(root, "legacy.env");
const auth = () => ({ type: "api_key", key: "test-auth" });
const resolve = () => resolveCredentials(auth, () => readConfigEnvFile(user, legacy));

try {
  const protectedPath = join(root, "config", "pi-extensions", ".env.web-search");
  assert.equal(sensitivePathLabel(protectedPath, root), ".env.web-search");
  assert.ok(detectSensitiveShellAccess(`Get-Content "${protectedPath}"`), "personal config retains credential-file protection");
  assert.equal(resolve().apiKey, "test-auth", "missing files preserve the Pi credential fallback");
  writeFileSync(legacy, "api_key=test-legacy\nbase_url=https://legacy.example\n", "utf8");
  assert.deepEqual(resolve(), { apiKey: "test-legacy", baseUrl: "https://legacy.example", source: "file" });

  // Aliases in the higher-priority file must override canonical names in the legacy file.
  writeFileSync(user, "apikey=test-personal\nbaseUrl=https://personal.example\n# 中文配置\n", "utf8");
  assert.deepEqual(resolve(), { apiKey: "test-personal", baseUrl: "https://personal.example", source: "file" });

  // Partial personal configuration falls back independently for the other field.
  writeFileSync(user, "base_url=https://personal.example\n", "utf8");
  assert.deepEqual(resolve(), { apiKey: "test-legacy", baseUrl: "https://personal.example", source: "file" });
  rmSync(legacy);
  assert.deepEqual(resolve(), { apiKey: "test-auth", baseUrl: "https://personal.example", source: "auth.json" });

  const before = readFileSync(user);
  resolve();
  assert.deepEqual(readFileSync(user), before, "loading never rewrites personal configuration");
  console.log("Personal configuration priority, aliases, legacy and auth fallbacks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
