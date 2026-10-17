/**
 * web-search: DeepSeek Search/Fetch tools for pi.
 *
 * Registers two read-only tools and a /websearch command family:
 *   - web_search(query, count?) — ranked results with model-facing summaries;
 *     the transcript box shows compact `score ¶authority` rows collapsed and a
 *     blocked detail layout expanded (ctrl+o toggles, pi-provided).
 *   - web_fetch(url, offset?) — paged Markdown of one page.
 *   - /websearch <query> — direct search overlay (no model round-trip)
 *   - /websearch fetch <n|url> — fetch the n-th result of the last /websearch
 *   - /websearch status — billed calls, cache hits, estimated cost
 *
 * Session-scoped TTL cache dedupes exact repeats for free; billing counters are
 * per process (5 CNY / 1000 successful calls). Credentials come from
 * DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL or ~/.pi/agent/.env (see client.ts).
 */
import { Type } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import {
  AgentToolResult,
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { ApiError, LimitError, PRICE_PER_CALL_CNY, SearchClient, type FetchResult, type SearchDetails } from "./web-search/client.js";
import {
  buildFetchLines,
  buildSearchLines,
  fetchContent,
  FETCH_PAGE_CHARS,
  searchContent,
  type FetchDetails,
} from "./web-search/render.js";

/** A component that renders lazily computed lines for the given width. */
class LinesComponent implements Component {
  private width = -1;
  private lines: string[] = [];

  constructor(private compute: (width: number) => string[]) {}

  render(width: number): string[] {
    if (width !== this.width) {
      this.lines = this.compute(width);
      this.width = width;
    }
    return this.lines;
  }

  invalidate(): void {
    this.width = -1;
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof LimitError || e instanceof ApiError) return e.message;
  return `web-search failed: ${(e as Error).message}`;
}

type SearchErrDetails = { query: string; error: string };
type FetchErrDetails = { url: string; error: string };
type SearchToolDetails = SearchDetails | SearchErrDetails;
type FetchToolDetails = FetchDetails | FetchErrDetails;

/** Full-screen overlay showing precomputed lines; Esc/Enter/q closes. */
async function showOverlay(ctx: ExtensionCommandContext, lines: (theme: Theme, width: number) => string[], hint: string): Promise<void> {
  await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => ({
    render: (width: number) => [...lines(theme, width), "", theme.fg("dim", ` ${hint}`)],
    invalidate() {},
    handleInput(data: string) {
      if (data === "\x1b" || data === "\r" || data === "q") done(undefined);
    },
  }));
}

export default function webSearch(pi: ExtensionAPI) {
  const client = new SearchClient();
  let lastSearch: SearchDetails | null = null;

  pi.registerTool(
    defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and return ranked results with summaries. Supports site:, -site:, \"exact phrase\", | (OR) and .. (range) syntax. " +
        "Each result carries rerank_score (0-3, >=1.5 high quality) and authority (0-4, >=3 highly authoritative). " +
        "Call web_fetch(url) when you need the full page.",
      promptSnippet: "web search with ranked results and page fetch",
      promptGuidelines: [
        "Prefer web_search for time-sensitive or unverifiable facts instead of guessing; results include per-source authority scores.",
      ],
      annotations: { readOnlyHint: true, openWorldHint: true },
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 128, description: "Search query, 1-128 chars. Supports site:, quotes, |, .. syntax." }),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of results (default 5)." })),
      }),
      outputSchema: Type.Object({
        query: Type.String(),
        count: Type.Integer(),
        cached: Type.Boolean(),
        results: Type.Array(
          Type.Object({
            rerank_score: Type.Number(),
            authority: Type.Integer(),
            title: Type.String(),
            url: Type.String(),
            snippet: Type.String(),
            summary: Type.String(),
            site_name: Type.Union([Type.String(), Type.Null()]),
            date: Type.Union([Type.String(), Type.Null()]),
            mirror_of: Type.Optional(Type.Integer()),
          }),
        ),
      }),

      async execute(_toolCallId, params): Promise<AgentToolResult<SearchToolDetails>> {
        try {
          const details = await client.search(params.query, params.count ?? 5);
          return {
            content: [{ type: "text", text: searchContent(details) }],
            details,
            structuredContent: {
              query: details.query,
              count: details.count,
              cached: details.cached,
              results: details.results.map((r, i) => ({
                rerank_score: r.rerank_score,
                authority: r.authority,
                title: r.title,
                url: r.url,
                snippet: r.snippet,
                summary: r.summary,
                site_name: r.site_name,
                date: r.date,
                ...(details.mirrors[i] ? { mirror_of: details.mirrors[i] } : {}),
              })),
            },
          };
        } catch (e) {
          const msg = errorMessage(e);
          return { content: [{ type: "text", text: msg }], details: { query: params.query, error: msg }, isError: true };
        }
      },

      renderCall: (args, theme) =>
        new LinesComponent(() => [
          theme.bold(theme.fg("accent", "⚡ web_search ")) +
            theme.fg("text", `"${args.query}"`) +
            theme.fg("dim", ` ×${args.count ?? 5}`),
        ]),

      renderResult: (result, options: ToolRenderResultOptions, theme: Theme) => {
        const details = result.details as SearchToolDetails | undefined;
        if (!details || "error" in details) {
          return new LinesComponent(() => [theme.fg("error", `✗ web_search: ${details?.error ?? "unknown"}`)]);
        }
        return new LinesComponent(buildSearchLines(details, theme, { expanded: options.expanded }));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch one web page and return it as Markdown, 20,000 characters per call; pass offset to continue reading a truncated page. " +
        "Only http/https without embedded credentials. Note: JavaScript-only pages (e.g. NVD detail views) and non-HTML endpoints (JSON feeds) often yield no content; prefer web_search for those.",
      promptSnippet: "fetch a web page as Markdown",
      annotations: { readOnlyHint: true, openWorldHint: true },
      parameters: Type.Object({
        url: Type.String({ maxLength: 8192, description: "Absolute http(s) URL to fetch." }),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to continue reading a truncated page." })),
        length: Type.Optional(Type.Integer({ minimum: 200, maximum: 40_000, description: "Characters to return (default 20000)." })),
      }),
      outputSchema: Type.Object({
        url: Type.String(),
        title: Type.String(),
        total_chars: Type.Integer(),
        offset: Type.Integer(),
        truncated: Type.Boolean(),
      }),

      async execute(_toolCallId, params): Promise<AgentToolResult<FetchToolDetails>> {
        try {
          const offset = params.offset ?? 0;
          const page: FetchResult & { costCny: number } = await client.fetchPage(params.url);
          const length = params.length ?? FETCH_PAGE_CHARS;
          const text = fetchContent(page, params.url, offset, length);
          const window = text.split("\n\n").slice(2).join("\n\n");
          const details: FetchDetails = {
            url: params.url,
            title: page.title,
            totalChars: page.content.length,
            offset,
            length: Math.min(length, Math.max(0, page.content.length - offset)),
            text: window,
            costCny: page.costCny,
          };
          return {
            content: [{ type: "text", text }],
            details,
            structuredContent: {
              url: details.url,
              title: details.title,
              total_chars: details.totalChars,
              offset: details.offset,
              truncated: details.offset + details.length < details.totalChars,
            },
          };
        } catch (e) {
          const msg = errorMessage(e);
          return { content: [{ type: "text", text: msg }], details: { url: params.url, error: msg }, isError: true };
        }
      },

      renderCall: (args, theme) =>
        new LinesComponent(() => [theme.bold(theme.fg("accent", "🌐 web_fetch ")) + theme.fg("text", args.url)]),

      renderResult: (result, options: ToolRenderResultOptions, theme: Theme) => {
        const details = result.details as FetchToolDetails | undefined;
        if (!details || "error" in details) {
          return new LinesComponent(() => [theme.fg("error", `✗ web_fetch: ${details?.error ?? "unknown"}`)]);
        }
        if (!options.expanded) {
          return new LinesComponent(() => [
            theme.fg("muted", `web_fetch · ${details.title || "(untitled)"} · ${details.totalChars} chars · offset ${details.offset}`),
          ]);
        }
        return new LinesComponent(buildFetchLines(details, theme));
      },
    }),
  );

  /* ---------- /websearch command family ---------- */

  pi.registerCommand("websearch", {
    description: "DeepSeek web search: /websearch <query> | /websearch fetch <n|url> | /websearch status",
    handler: async (args, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);

      if (argv.length === 0 || argv[0] === "status") {
        const s = client.stats();
        ctx.ui.notify(
          `web-search · calls ${s.billed} (cache ${s.cacheHits}) · est ¥${(s.billed * PRICE_PER_CALL_CNY).toFixed(3)} · limit ${s.dailyLimit}/day` +
            (s.lastError ? ` · ${s.lastError}` : ""),
          "info",
        );
        return;
      }

      if (argv[0] === "fetch") {
        const target = argv[1];
        let url: string | undefined;
        if (target && /^\d+$/.test(target)) {
          const r = lastSearch?.results[Number(target) - 1];
          if (!r) {
            ctx.ui.notify(`没有第 ${target} 条结果；先运行 /websearch <query>`, "error");
            return;
          }
          url = r.url;
        } else if (target) {
          url = target;
        } else {
          ctx.ui.notify("用法：/websearch fetch <n|url>", "error");
          return;
        }
        try {
          const page = await client.fetchPage(url);
          const text = fetchContent(page, url, 0, FETCH_PAGE_CHARS * 2);
          const details: FetchDetails = {
            url,
            title: page.title,
            totalChars: page.content.length,
            offset: 0,
            length: Math.min(FETCH_PAGE_CHARS * 2, page.content.length),
            text: text.split("\n\n").slice(2).join("\n\n"),
            costCny: page.costCny,
          };
          await showOverlay(ctx, (theme, width) => buildFetchLines(details, theme)(width), "Esc 关闭");
        } catch (e) {
          ctx.ui.notify(errorMessage(e), "error");
        }
        return;
      }

      /* direct search */
      const query = argv.join(" ");
      try {
        const details = await client.search(query, 5);
        lastSearch = details;
        if (ctx.mode === "tui") {
          await showOverlay(
            ctx,
            (theme, width) => buildSearchLines(details, theme)(width),
            "Esc 关闭 · /websearch fetch <n> 取全文",
          );
        } else {
          const top = details.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title} — ${r.url}`);
          ctx.ui.notify([`web_search "${query}" · ${details.results.length} 条`, ...top].join("\n"), "info");
        }
      } catch (e) {
        ctx.ui.notify(errorMessage(e), "error");
      }
    },
  });
}
