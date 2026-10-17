import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type AnimStyle = "random" | "comet" | "wave" | "chase";
export type FixedStyle = Exclude<AnimStyle, "random">;

const STYLE_ALIASES: Record<string, FixedStyle> = { a: "comet", f: "wave", g: "chase" };

/** 解析样式值；非法输入回退 random（画廊字母 a/f/g 也接受） */
export function parseStyle(raw: unknown): AnimStyle {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (value === "random" || value === "comet" || value === "wave" || value === "chase") return value;
	return STYLE_ALIASES[value] ?? "random";
}

export function agentSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 样式优先级：PI_COMET_STYLE 环境变量 > settings.json `cometCompactionStyle` > random */
export function readStyleConfig(envValue: string | undefined, settingsPath: string): AnimStyle {
	if (envValue !== undefined && envValue.trim() !== "") return parseStyle(envValue);
	try {
		const raw: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (raw && typeof raw === "object" && "cometCompactionStyle" in raw) {
			return parseStyle((raw as Record<string, unknown>).cometCompactionStyle);
		}
	} catch {
		// 文件缺失或损坏 → 默认
	}
	return "random";
}

/**
 * 把样式写回 settings.json，保留其他键。Pi 暴露的文件变更队列用于
 * 串行化同一运行时中的设置写入；同目录临时文件 + rename 避免留下半写文件。
 */
export async function saveStyleSetting(
	style: AnimStyle,
	settingsPath: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		return await withFileMutationQueue(settingsPath, async () => {
			let record: Record<string, unknown> = {};
			try {
				const raw: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					return { ok: false, error: "settings.json 不是 JSON 对象，已取消写入" };
				}
				record = raw as Record<string, unknown>;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					const isJsonError = error instanceof SyntaxError;
					return {
						ok: false,
						error: isJsonError
							? "settings.json 解析失败，已取消写入以免破坏现有设置"
							: `读取 settings.json 失败：${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}

			record.cometCompactionStyle = style;
			const directory = dirname(settingsPath);
			const temporaryPath = join(directory, `.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`);
			try {
				mkdirSync(directory, { recursive: true });
				writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
					encoding: "utf8",
					flag: "wx",
				});
				renameSync(temporaryPath, settingsPath);
				return { ok: true };
			} catch (error) {
				try {
					unlinkSync(temporaryPath);
				} catch {
					// The temporary file may not have been created.
				}
				return {
					ok: false,
					error: `写入 settings.json 失败：${error instanceof Error ? error.message : String(error)}`,
				};
			}
		});
	} catch (error) {
		return {
			ok: false,
			error: `写入 settings.json 失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** random 时从三种动画里抽一个（rng 可注入便于测试） */
export function chooseStyle(configured: AnimStyle, rng: () => number = Math.random): FixedStyle {
	if (configured !== "random") return configured;
	const pool: readonly FixedStyle[] = ["comet", "wave", "chase"];
	return pool[Math.floor(rng() * pool.length) % pool.length] as FixedStyle;
}
