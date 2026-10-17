/**
 * anim-compaction.ts — 压缩期间的加载动画（彗星 / 均衡器 / 追逐点，可配置）
 *
 * 触发：session_before_compact（手动 /compact、阈值自动、溢出恢复）
 * 位置：编辑器上方 widget（aboveEditor），不抢键盘焦点，编辑器保留 Esc 取消压缩
 * 收尾：session_compact / session_compact_failed；agent_settled、session_start 与 session_shutdown 兜底
 *
 * 切换方式：/anim 命令 —— 不带参数弹出选择列表，带参数直接设值；选择后持久化写回
 * settings.json（保留其他键，损坏时拒绝写入）。也可直接改 settings.json。
 *
 * 动画样式（配置 cometCompactionStyle，或环境变量 PI_COMET_STYLE 覆盖）：
 *   "random"（默认）— 每次压缩随机选一种
 *   "comet"  / "a" — 16 格彗星条（金→珊瑚→蓝→青拖尾）
 *   "wave"   / "f" — 均衡器波形（▁▂▃▄▅▆▇ 起伏右移，越高越暖）
 *   "chase"  / "g" — 8 点追逐（金色头部 + 渐隐拖尾）
 * 行内容：旋转指示符 + 动画 + 金色时间 + 暗淡消息数 + 蓝色 token 规模 + 暗淡原因
 * （如 "40.6s · 71 msgs · 31.2k tok · auto"）——内置行已含 "Auto-compacting...
 * (esc to cancel)"，不重复。消息数为真实待总结条数
 * （preparation.messagesToSummarize.length），token 取 preparation.tokensBefore，
 * 原因取 event.reason（manual 不标；threshold → auto；overflow → overflow）。
 *
 * 主题适配：按 ctx.ui.theme.appearance 选配色——暗色 = 亮色系，亮色 = 加深色系
 * 且"暗淡"用中灰（ESC[2m 在亮底发虚）。内置 "Auto-compacting..." 行保留不动。
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	agentSettingsPath,
	chooseStyle,
	parseStyle,
	readStyleConfig,
	saveStyleSetting,
	type AnimStyle,
	type FixedStyle,
} from "./anim-compaction/settings.js";
import { performance } from "node:perf_hooks";

export {
	agentSettingsPath,
	chooseStyle,
	parseStyle,
	readStyleConfig,
	saveStyleSetting,
} from "./anim-compaction/settings.js";
export type { AnimStyle, FixedStyle } from "./anim-compaction/settings.js";

const WIDGET_KEY = "anim-compaction";
const TICK_MS = 50;
const TRAIL = 8;
const MIN_BAR = 12;
const MAX_BAR = 16;
const CHASE_DOTS = 8;
const ROT = ["-", "\\", "|", "/"] as const;
const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

// ---------- 主题适配配色 ----------

export interface Palette {
	dim: string;
	gold: string;
	accent: string; // 标签内数字用（token 规模）：暗色取蓝，亮色取深蓝
	colors: readonly string[]; // 彗头 → 彗尾
	reset: string;
}

/** 暗色终端 = 原版亮色系；亮色终端 = 整体加深，暗淡改中灰 */
export function paletteFor(appearance: string | undefined): Palette {
	if (appearance === "light") {
		return {
			dim: "\x1b[38;2;110;110;110m",
			gold: "\x1b[38;2;168;118;16m",
			accent: "\x1b[38;2;28;102;140m",
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
		accent: "\x1b[38;2;77;154;191m",
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

/** 压缩附加信息：token 规模与触发原因（manual 不显示原因段） */
export interface CompactionInfo {
	tokens?: number;
	reason?: "manual" | "threshold" | "overflow";
}

/** token 数格式化：31240 → "31.2k"，990 → "990" */
export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function fitLine(line: string, width: number, pal: Palette): string {
	const clipped = truncateToWidth(line, Math.max(0, Math.floor(width)), "");
	return clipped.endsWith(pal.reset) ? clipped : `${clipped}${pal.reset}`;
}

/** 完整行：旋转指示符 + 动画 + 标签（时间金色、消息数暗淡、token 蓝、原因暗淡） */
export function overlayLine(
	style: FixedStyle,
	step: number,
	elapsedMs: number,
	width: number,
	msgCount: number,
	pal: Palette,
	info?: CompactionInfo,
): string {
	const time = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
	const tokSeg = info?.tokens !== undefined && info.tokens > 0 ? ` · ${formatTokens(info.tokens)} tok` : "";
	const reasonSeg = info?.reason === "threshold" ? " · auto" : info?.reason === "overflow" ? " · overflow" : "";
	const label =
		`${pal.gold}${time}${pal.reset}${pal.dim} · ${msgCount} msgs` +
		`${tokSeg ? `${pal.reset}${pal.accent}${tokSeg}` : ""}` +
		`${reasonSeg ? `${pal.reset}${pal.dim}${reasonSeg}` : ""}${pal.reset}`;
	const rot = ROT[((step % ROT.length) + ROT.length) % ROT.length] as string;
	const labelVisible = time.length + ` · ${msgCount} msgs`.length + tokSeg.length + reasonSeg.length;
	const pad = style === "chase" ? 3 : 2;
	const budget = width - labelVisible - 4 - pad; // prefix + animation padding + label
	if (budget < (style === "chase" ? CHASE_DOTS * 2 - 1 : MIN_BAR)) {
		return fitLine(` ${rot}  ${label}`, width, pal);
	}
	const anim =
		style === "wave"
			? waveBar(step, Math.min(MAX_BAR, budget), pal)
			: style === "chase"
				? chaseFrame(step, CHASE_DOTS, pal)
				: cometBar(step, Math.min(MAX_BAR, budget), pal);
	return fitLine(` ${rot}  ${anim}${" ".repeat(pad)}${label}`, width, pal);
}

// ---------- 组件 ----------

/** 自驱动动画：定时器推进 step 并请求重绘；dispose 清理定时器 */
class CometWidget implements Component {
	private readonly tui: TUI;
	private readonly appearance: string | undefined;
	private readonly style: FixedStyle;
	private readonly msgCount: number;
	private readonly info: CompactionInfo;
	private step = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly startedAt = performance.now();

	constructor(tui: TUI, appearance: string | undefined, style: FixedStyle, msgCount: number, info: CompactionInfo) {
		this.tui = tui;
		this.appearance = appearance;
		this.style = style;
		this.msgCount = msgCount;
		this.info = info;
		this.timer = setInterval(() => {
			this.step++;
			this.tui.requestRender();
		}, TICK_MS);
	}

	render(width: number): string[] {
		return [
			overlayLine(
				this.style,
				this.step,
				performance.now() - this.startedAt,
				width,
				this.msgCount,
				paletteFor(this.appearance),
				this.info,
			),
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
			const result = await saveStyleSetting(picked, settingsPath());
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

	const start = (ctx: ExtensionContext, msgCount: number, info: CompactionInfo) => {
		if (ctx.mode !== "tui" || shown) return;
		shown = true;
		const configured = readStyleConfig(process.env.PI_COMET_STYLE, agentSettingsPath());
		const style = chooseStyle(configured);
		const appearance = ctx.ui.theme?.appearance;
		// 工厂重载：组件自带定时器动画，随 widget 移除自动 dispose
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: TUI) => new CometWidget(tui, appearance, style, msgCount, info),
			{ placement: "aboveEditor" },
		);
	};

	const stop = (ctx: ExtensionContext) => {
		if (!shown) return;
		shown = false;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	pi.on("session_before_compact", async (event, ctx) => {
		const prep = event.preparation;
		start(ctx, prep?.messagesToSummarize?.length ?? 0, {
			tokens: prep?.tokensBefore,
			reason: event.reason,
		});
	});
	pi.on("session_compact", async (_event, ctx) => stop(ctx));
	pi.on("session_compact_failed", async (_event, ctx) => stop(ctx));
	// 安全网：其他扩展取消压缩时（两个结束事件都不发）由 agent 收束兜底；
	// 会话切换时 pi 清空 widget，这里同步重置标记
	pi.on("agent_settled", async (_event, ctx) => stop(ctx));
	pi.on("session_start", async (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", async (_event, ctx) => stop(ctx));
}
