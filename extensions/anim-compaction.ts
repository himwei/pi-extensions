/**
 * anim-compaction.ts — 压缩期间的加载动画（彗星 / 均衡器 / 追逐点，可配置）
 *
 * 触发：session_before_compact（手动 /compact、阈值自动、溢出恢复）
 * 位置：编辑器上方 widget（aboveEditor），不抢键盘焦点，编辑器保留 Esc 取消压缩
 * 收尾：session_compact / session_compact_failed；agent_settled 与 session_start 兜底
 *
 * 切换方式：/anim 命令 —— 不带参数弹出选择列表，带参数直接设值；选择后持久化写回
 * settings.json（保留其他键，损坏时拒绝写入）。也可直接改 settings.json。
 *
 * 动画样式（配置 cometCompactionStyle，或环境变量 PI_COMET_STYLE 覆盖）：
 *   "random"（默认）— 每次压缩随机选一种
 *   "comet"  / "a" — 16 格彗星条（金→珊瑚→蓝→青拖尾）
 *   "wave"   / "f" — 均衡器波形（▁▂▃▄▅▆▇ 起伏右移，越高越暖）
 *   "chase"  / "g" — 8 点追逐（金色头部 + 渐隐拖尾）
 * 行内容：旋转指示符 + 动画 + Compacting context X.Xs · N msgs (esc to cancel)；
 * N 为真实待总结消息数（preparation.messagesToSummarize.length），时间金色高亮。
 *
 * 主题适配：按 ctx.ui.theme.appearance 选配色——暗色 = 亮色系，亮色 = 加深色系
 * 且"暗淡"用中灰（ESC[2m 在亮底发虚）。内置 "Auto-compacting..." 行保留不动。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "anim-compaction";
const TICK_MS = 50;
const TRAIL = 8;
const MIN_BAR = 12;
const MAX_BAR = 16;
const CHASE_DOTS = 8;
const ROT = ["-", "\\", "|", "/"] as const;
const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

// ---------- 配置 ----------

export type AnimStyle = "random" | "comet" | "wave" | "chase";
export type FixedStyle = Exclude<AnimStyle, "random">;
const STYLE_ALIASES: Record<string, FixedStyle> = { a: "comet", f: "wave", g: "chase" };

/** 解析样式值；非法输入回退 random（画廊字母 a/f/g 也接受） */
export function parseStyle(raw: unknown): AnimStyle {
	const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (v === "random" || v === "comet" || v === "wave" || v === "chase") return v;
	return STYLE_ALIASES[v] ?? "random";
}

export function agentSettingsPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
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

/** 把样式写回 settings.json（保留其他键）；文件损坏时拒绝写入以免破坏用户设置 */
export function saveStyleSetting(style: AnimStyle, settingsPath: string): { ok: boolean; error?: string } {
	let record: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			const raw: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				return { ok: false, error: "settings.json 不是 JSON 对象，已取消写入" };
			}
			record = raw as Record<string, unknown>;
		} catch {
			return { ok: false, error: "settings.json 解析失败，已取消写入以免破坏现有设置" };
		}
	}
	record.cometCompactionStyle = style;
	writeFileSync(settingsPath, JSON.stringify(record, null, 2) + "\n", "utf8");
	return { ok: true };
}

/** random 时从三种动画里抽一个（rng 可注入便于测试） */
export function chooseStyle(configured: AnimStyle, rng: () => number = Math.random): FixedStyle {
	if (configured !== "random") return configured;
	const pool: readonly FixedStyle[] = ["comet", "wave", "chase"];
	return pool[Math.floor(rng() * pool.length) % pool.length] as FixedStyle;
}

// ---------- 主题适配配色 ----------

export interface Palette {
	dim: string;
	gold: string;
	colors: readonly string[]; // 彗头 → 彗尾
	reset: string;
}

/** 暗色终端 = 原版亮色系；亮色终端 = 整体加深，暗淡改中灰 */
export function paletteFor(appearance: string | undefined): Palette {
	if (appearance === "light") {
		return {
			dim: "\x1b[38;2;110;110;110m",
			gold: "\x1b[38;2;168;118;16m",
			colors: [
				"\x1b[38;2;168;118;16m", // 琥珀
				"\x1b[38;2;190;74;56m", // 砖红
				"\x1b[38;2;28;102;140m", // 深蓝
				"\x1b[38;2;18;111;120m", // 深青
			],
			reset: "\x1b[0m",
		};
	}
	return {
		dim: "\x1b[2m",
		gold: "\x1b[38;2;241;190;88m",
		colors: [
			"\x1b[38;2;241;190;88m", // gold
			"\x1b[38;2;240;144;130m", // coral
			"\x1b[38;2;77;154;191m", // blue
			"\x1b[38;2;131;204;210m", // turquoise
		],
		reset: "\x1b[0m",
	};
}

// ---------- 动画渲染（纯函数）----------

/** 彗星条：游程编码合并同色转义段；周期 width + trail 无缝回绕 */
export function cometBar(step: number, width: number, pal: Palette): string {
	const cycle = width + TRAIL;
	const head = ((step % cycle) + cycle) % cycle;
	const segOf = (age: number): string =>
		age >= 0 && age < TRAIL ? (pal.colors[Math.min(Math.floor(age / 2), 3)] as string) : pal.dim;
	let bar = "";
	let i = 0;
	while (i < width) {
		const seg = segOf(head - i);
		const ch = seg === pal.dim ? "-" : "#";
		let n = 1;
		while (i + n < width && segOf(head - (i + n)) === seg) n++;
		bar += seg + ch.repeat(n) + pal.reset;
		i += n;
	}
	return bar;
}

/** 均衡器波形：高度沿三角波起伏并向右传播，越高越暖 */
export function waveBar(step: number, width: number, pal: Palette): string {
	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		const phase = (((step + i * 2) % 14) + 14) % 14;
		const h = phase < 7 ? phase : 13 - phase;
		cells.push((pal.colors[3 - Math.floor(h / 2)] as string) + LEVELS[h] + pal.reset);
	}
	return cells.join("");
}

/** 追逐点列：金色头部每帧右移一格，拖尾渐隐（珊瑚 • → 暗 • → 暗 ·） */
export function chaseFrame(step: number, dots: number, pal: Palette): string {
	const parts: string[] = [];
	for (let i = 0; i < dots; i++) {
		const age = (((step - i) % dots) + dots) % dots;
		if (age === 0) parts.push(`${pal.gold}●${pal.reset}`);
		else if (age === 1) parts.push(`${pal.colors[1]}•${pal.reset}`);
		else if (age === 2) parts.push(`${pal.dim}•${pal.reset}`);
		else parts.push(`${pal.dim}·${pal.reset}`);
	}
	return parts.join(" ");
}

/** 完整行：旋转指示符 + 动画 + 标签（时间金色、消息数真实、提示暗淡） */
export function overlayLine(
	style: FixedStyle,
	step: number,
	elapsedMs: number,
	width: number,
	msgCount: number,
	pal: Palette,
): string {
	const time = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
	const label =
		`${pal.dim}Compacting context ${pal.reset}${pal.gold}${time}${pal.reset}` +
		`${pal.dim} · ${msgCount} msgs (esc to cancel)${pal.reset}`;
	const rot = ROT[((step % ROT.length) + ROT.length) % ROT.length] as string;
	const labelVisible = 19 + time.length + ` · ${msgCount} msgs`.length + 16;
	const budget = width - labelVisible - 6; // " " + rot + "  " + 动画 + "  "
	if (budget < (style === "chase" ? CHASE_DOTS * 2 - 1 : MIN_BAR)) return ` ${rot}  ${label}`;
	const anim =
		style === "wave"
			? waveBar(step, Math.min(MAX_BAR, budget), pal)
			: style === "chase"
				? chaseFrame(step, CHASE_DOTS, pal)
				: cometBar(step, Math.min(MAX_BAR, budget), pal);
	const pad = style === "chase" ? 3 : 2;
	return ` ${rot}  ${anim}${" ".repeat(pad)}${label}`;
}

// ---------- 组件 ----------

/** 自驱动动画：定时器推进 step 并请求重绘；dispose 清理定时器 */
class CometWidget implements Component {
	private readonly tui: TUI;
	private readonly appearance: string | undefined;
	private readonly style: FixedStyle;
	private readonly msgCount: number;
	private step = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly startedAt = Date.now();

	constructor(tui: TUI, appearance: string | undefined, style: FixedStyle, msgCount: number) {
		this.tui = tui;
		this.appearance = appearance;
		this.style = style;
		this.msgCount = msgCount;
		this.timer = setInterval(() => {
			this.step++;
			this.tui.requestRender();
		}, TICK_MS);
	}

	render(width: number): string[] {
		return [
			overlayLine(this.style, this.step, Date.now() - this.startedAt, width, this.msgCount, paletteFor(this.appearance)),
		];
	}

	invalidate(): void {
		// 无缓存：每帧现算
	}

	dispose(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

// ---------- /comet 命令：选择列表 / 直接设值，持久化到 settings.json ----------

type MinimalCmdCtx = { ui: Pick<ExtensionUIContext, "select" | "notify"> };

const STYLE_MENU: readonly { value: AnimStyle; label: string }[] = [
	{ value: "random", label: "Random — 每次压缩随机换一种" },
	{ value: "comet", label: "Comet — 彗星  ----######" },
	{ value: "wave", label: "Wave — 均衡器  ▁▃▅▇▆▄▂" },
	{ value: "chase", label: "Chase — 追逐  ● • • · · ·" },
];

/** 命令工厂（env/路径可注入便于测试）：/anim [random|comet|wave|chase]，无参数弹选择列表 */
export function createCometCommand(
	inject: { env?: () => string | undefined; settingsPath?: () => string } = {},
): { description: string; handler: (args: string, ctx: MinimalCmdCtx) => Promise<void> } {
	const env = inject.env ?? (() => process.env.PI_COMET_STYLE);
	const settingsPath = inject.settingsPath ?? agentSettingsPath;
	return {
		description: "压缩动画样式：/anim [random|comet|wave|chase]，不带参数弹选择列表",
		handler: async (args: string, ctx: MinimalCmdCtx) => {
			if ((env() ?? "").trim() !== "") {
				ctx.ui.notify(`环境变量 PI_COMET_STYLE=${env()} 覆盖中，写入 settings 不生效`, "warning");
			}
			let picked: AnimStyle | undefined;
			if (args.trim() !== "") {
				const v = args.trim().toLowerCase();
				picked = parseStyle(v);
				if (!["random", "comet", "wave", "chase", "a", "f", "g"].includes(v)) {
					ctx.ui.notify(`无效样式 "${args.trim()}"，已回退 ${picked}`, "warning");
				}
			} else {
				const current = readStyleConfig(env(), settingsPath());
				const options = STYLE_MENU.map((s) => `${s.value === current ? "✓ " : "  "}${s.label}`);
				const choice = await ctx.ui.select("压缩动画样式", options);
				if (choice === undefined) return; // Esc 取消
				picked = STYLE_MENU[options.indexOf(choice)]?.value ?? "random";
			}
			const result = saveStyleSetting(picked, settingsPath());
			if (!result.ok) {
				ctx.ui.notify(result.error ?? "写入失败", "error");
				return;
			}
			ctx.ui.notify(`压缩动画已设为：${picked}`, "info");
		},
	};
}

export default function (pi: ExtensionAPI) {
	let shown = false;

	pi.registerCommand("anim", createCometCommand());

	const start = (ctx: ExtensionContext, msgCount: number) => {
		if (ctx.mode !== "tui" || shown) return;
		shown = true;
		const configured = readStyleConfig(process.env.PI_COMET_STYLE, agentSettingsPath());
		const style = chooseStyle(configured);
		const appearance = ctx.ui.theme?.appearance;
		// 工厂重载：组件自带定时器动画，随 widget 移除自动 dispose
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: TUI) => new CometWidget(tui, appearance, style, msgCount),
			{ placement: "aboveEditor" },
		);
	};

	const stop = (ctx: ExtensionContext) => {
		if (!shown) return;
		shown = false;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	pi.on("session_before_compact", async (event, ctx) => {
		start(ctx, event.preparation?.messagesToSummarize?.length ?? 0);
	});
	pi.on("session_compact", async (_event, ctx) => stop(ctx));
	pi.on("session_compact_failed", async (_event, ctx) => stop(ctx));
	// 安全网：其他扩展取消压缩时（两个结束事件都不发）由 agent 收束兜底；
	// 会话切换时 pi 清空 widget，这里同步重置标记
	pi.on("agent_settled", async (_event, ctx) => stop(ctx));
	pi.on("session_start", async (_event, ctx) => stop(ctx));
}
