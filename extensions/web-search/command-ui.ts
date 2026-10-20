import { matchesKey } from "@earendil-works/pi-tui";
import { BorderedLoader, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";

/** Pi owns the loader and focus; keep it open until cancellation actually settles. */
export async function commandRequest<T>(
  ctx: ExtensionCommandContext, shutdown: AbortSignal, label: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  const signal = AbortSignal.any([shutdown, controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
  signal.throwIfAborted();
  if (ctx.mode !== "tui") return request(signal);
  const result = await ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, label + "（Esc 取消）");
    loader.onAbort = () => controller.abort();
    void request(signal).then(value => done({ value }), error => done({ error }));
    return loader;
  });
  if (signal.aborted) {
    if (!shutdown.aborted) ctx.ui.notify("/websearch 已取消", "info");
    return undefined;
  }
  if ("error" in result) throw result.error;
  return result.value;
}

/** Full-screen results; native key matching also handles enhanced terminal key protocols. */
export async function showOverlay(
  ctx: ExtensionCommandContext, lines: (theme: Theme, width: number) => string[], hint: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => {
    let settled = false;
    const close = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", close);
      done(undefined);
    };
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    return {
      render: (width: number) => [...lines(theme, width), "", theme.fg("dim", " " + hint)],
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") close();
      },
      dispose() { signal.removeEventListener("abort", close); },
    };
  });
}
