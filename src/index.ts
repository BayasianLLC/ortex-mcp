import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { z } from "zod";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const ORTEX_BASE = "https://api.ortex.com";
const API_KEY = process.env.ORTEX_API_KEY ?? "TEST";
const PORT = parseInt(process.env.PORT ?? "3000");

// ─────────────────────────────────────────────
// HTTP CLIENT
// ─────────────────────────────────────────────
async function ortexGet(path: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
  const url = new URL(`${ORTEX_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      "Ortex-Api-Key": API_KEY,
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORTEX API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// MCP TOOLS — registered per-request (stateless)
// ─────────────────────────────────────────────
function registerTools(server: McpServer): void {

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 1: SHORT INTEREST (daily time series)
// Core input for the borrow spread and squeeze model
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_short_interest",
  "Daily short interest time series for a ticker: shares shorted, % of free float, USD value. " +
  "Use for squeeze setup detection and short interest trend analysis. " +
  "Exchange: 'nasdaq' or 'nyse' or 'us' for all US exchanges.",
  {
    ticker: z.string().describe("Ticker symbol e.g. AKAM, SAIL, S"),
    exchange: z.string().default("us").describe("Exchange: 'nasdaq', 'nyse', or 'us' for all US"),
    from_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 1 month ago)"),
    to_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    page_size: z.number().default(30).describe("Records per page (default 30)"),
  },
  async ({ ticker, exchange, from_date, to_date, page_size }) => {
    const data = await ortexGet(`/api/v1/${exchange}/${ticker}/short_interest`, {
      ...(from_date && { from_date }),
      ...(to_date && { to_date }),
      page_size,
      format: "json",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 2: COST TO BORROW (CTB) — daily APR from lending market
// THE core input for borrow spread vs ORATS implied borrow
// This is the lending market signal that leads options pricing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_cost_to_borrow",
  "Daily cost to borrow (CTB) as annualized % rate from the securities lending market. " +
  "This is the ACTUAL lending market rate — compare against ORATS borrow_signal (derivatives-implied) " +
  "to detect the borrow spread. When ORTEX CTB leads ORATS implied, lending market is ahead of options: early squeeze signal. " +
  "When ORATS > ORTEX, options are overpricing squeeze risk — shorts sitting cheap.",
  {
    ticker: z.string().describe("Ticker symbol"),
    exchange: z.string().default("us").describe("Exchange: 'nasdaq', 'nyse', or 'us'"),
    from_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 1 month ago)"),
    to_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    page_size: z.number().default(30).describe("Records per page"),
  },
  async ({ ticker, exchange, from_date, to_date, page_size }) => {
    const data = await ortexGet(`/api/v1/stock/${exchange}/${ticker}/ctb/all`, {
      ...(from_date && { from_date }),
      ...(to_date && { to_date }),
      page_size,
      format: "json",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 3: SHORT AVAILABILITY
// Shares available to borrow as % of outstanding short interest
// When this collapses below ~40%, shorts hit structural ceiling
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_short_availability",
  "Daily shares available to borrow, expressed as % of current short interest. " +
  "Availability < 40% = structural ceiling: shorts cannot add, any positive catalyst forces asymmetric cover. " +
  "Availability 40-70% = constrained. > 70% = open, shorts can grow. " +
  "Cross this against CTB to confirm squeeze setup: rising CTB + collapsing availability = shorts under maximum pressure.",
  {
    ticker: z.string().describe("Ticker symbol"),
    exchange: z.string().default("us").describe("Exchange: 'nasdaq', 'nyse', or 'us'"),
    from_date: z.string().optional().describe("Start date YYYY-MM-DD"),
    to_date: z.string().optional().describe("End date YYYY-MM-DD"),
    page_size: z.number().default(30).describe("Records per page"),
  },
  async ({ ticker, exchange, from_date, to_date, page_size }) => {
    const data = await ortexGet(`/api/v1/stock/${exchange}/${ticker}/availability`, {
      ...(from_date && { from_date }),
      ...(to_date && { to_date }),
      page_size,
      format: "json",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 4: OPTIONS PCR SENTIMENT with days_fwd segmentation
// The McMillan/Natenberg signal: near-dated vs long-dated PCR divergence
// Near-dated PCR = retail binary fear (noise)
// Long-dated PCR = institutional structural positioning (signal)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_pcr_sentiment",
  "Put/Call Ratio sentiment with optional expiry horizon filter (days_fwd). " +
  "Call without days_fwd for full-chain PCR. " +
  "Call with days_fwd=30 for near-dated (retail binary fear signal). " +
  "Call with days_fwd=180 for long-dated (institutional structural positioning signal). " +
  "DIVERGENCE between near and long PCR is the key signal: " +
  "near elevated + long flat = fear is event-driven, not structural (McMillan contrarian sell). " +
  "Both elevated = institutional put buying multi-quarter (Taleb tail setup, respect it).",
  {
    ticker: z.string().describe("Ticker symbol"),
    exchange: z.string().default("us").describe("Exchange: 'nasdaq', 'nyse', or 'us'"),
    days_fwd: z.number().optional().describe(
      "Consider contracts expiring within this many days. " +
      "Omit for full chain. Use 30 for near-dated, 90+ for long-dated. Call TWICE for divergence analysis."
    ),
  },
  async ({ ticker, exchange, days_fwd }) => {
    const data = await ortexGet(`/api/v1/${exchange}/${ticker}/options/pcr`, {
      ...(days_fwd !== undefined && { days_fwd }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 5: SHARES OUTSTANDING (daily time series)
// For SBC dilution cross-analysis vs insider selling velocity
// Annualized dilution rate + insider sell flow = compound drain per share
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_shares_outstanding",
  "Daily shares outstanding time series. " +
  "Use to compute annualized dilution rate for SBC-heavy growth names (SAIL, S, SNOW, DT). " +
  "Cross against UW insider_transactions to compute compound drain: " +
  "(annual dilution % + insider sell $/shares) / remaining shares = real per-share extraction rate. " +
  "Also catches stealth secondary offerings before press releases.",
  {
    ticker: z.string().describe("Ticker symbol"),
    exchange: z.string().default("us").describe("Exchange: 'nasdaq', 'nyse', or 'us'"),
    from_date: z.string().describe("Start date YYYY-MM-DD (required)"),
    to_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    page_size: z.number().default(60).describe("Records per page (use 60+ for trend analysis)"),
  },
  async ({ ticker, exchange, from_date, to_date, page_size }) => {
    const data = await ortexGet(`/api/v1/${exchange}/${ticker}/shares_outstanding`, {
      from_date,
      ...(to_date && { to_date }),
      page_size,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 6: DAYS TO COVER (index-level scan)
// Scan S&P 500 or Nasdaq 100 for structural DTC outliers
// Portfolio-level squeeze pressure screening
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_days_to_cover_index",
  "Scan an index for days-to-cover data across all constituents. " +
  "Use for portfolio-level screening: find names with extreme DTC before running single-stock deep dive. " +
  "Index options: 'US-S 500' (S&P 500), 'US-N 100' (Nasdaq 100), 'UK Top 100', 'Europe Top 600'.",
  {
    index: z.enum(["US-S 500", "US-N 100", "UK Top 100", "Europe Top 600"])
      .default("US-S 500")
      .describe("Index to scan"),
    date: z.string().optional().describe("Date YYYY-MM-DD (default: latest available)"),
    page_size: z.number().default(50).describe("Records per page"),
  },
  async ({ index, date, page_size }) => {
    const data = await ortexGet(`/api/v1/index/days_to_cover`, {
      index,
      ...(date && { date }),
      page_size,
      format: "json",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 7: SHORT INTEREST INDEX SCAN
// Index-level SI scan with shortScore composite
// For screening before single-stock deep dives
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_short_interest_index",
  "Scan an entire index for short interest data including ORTEX shortScore composite. " +
  "Returns SI shares, SI % of free float, USD value, and shortScore for all index constituents. " +
  "Use for portfolio-level screening to identify which names warrant single-stock CTB + availability deep dive.",
  {
    index: z.enum(["US-S 500", "US-N 100", "UK Top 100", "Europe Top 600"])
      .default("US-S 500")
      .describe("Index to scan"),
    date: z.string().optional().describe("Date YYYY-MM-DD (default: latest available)"),
    page_size: z.number().default(50).describe("Records per page"),
  },
  async ({ index, date, page_size }) => {
    const data = await ortexGet(`/api/v1/index/short_interest`, {
      index,
      ...(date && { date }),
      page_size,
      format: "json",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 8: EARNINGS CALENDAR
// Catalyst timing layer — pairs with ORATS earnings_intel
// Know the event window before running the microstructure model
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_earnings_calendar",
  "Upcoming and historical earnings announcements with timestamps. " +
  "Use as catalyst timing layer: before running the microstructure model, confirm the event window. " +
  "Pairs with ORATS earnings_intel to validate implied move vs historical realized move.",
  {
    from_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 1 week ago)"),
    to_date: z.string().optional().describe("End date YYYY-MM-DD (default: 30 days forward, max 1 month range)"),
    page_size: z.number().default(20).describe("Records per page"),
  },
  async ({ from_date, to_date, page_size }) => {
    const data = await ortexGet(`/api/v1/earnings`, {
      ...(from_date && { from_date }),
      ...(to_date && { to_date }),
      page_size,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 9: STOCK SCORES with custom weights (POST)
// FUTURE USE: build a custom 5-Box weighted score
// that only activates the metrics relevant to your framework
// Deliberately excluded from primary model — here for future experiments
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_stock_scores",
  "ORTEX composite stock scores: quality, growth, momentum, value. " +
  "Supports custom weight overrides via POST body. " +
  "NOTE: use sparingly — composite scores are Bloomberg territory. " +
  "Best use: custom weights that zero out everything except momentum + DTC + short-specific metrics " +
  "to create a pure positioning pressure score, not a fundamental score.",
  {
    ticker: z.string().describe("Ticker symbol"),
    exchange: z.string().default("us").describe("Exchange: 'nasdaq', 'nyse', or 'us'"),
    from_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 1 month)"),
    custom_weights: z.record(z.number()).optional().describe(
      "Optional custom weights object. Keys: quality, growth, momentum, value, dtc, fcf_assets, etc. " +
      "Missing keys default to 0. Example: { 'momentum': 65, 'dtc': 100 }"
    ),
  },
  async ({ ticker, exchange, from_date, custom_weights }) => {
    const url = new URL(`${ORTEX_BASE}/api/v1/${exchange}/${ticker}/stock_scores`);
    if (from_date) url.searchParams.set("from_date", from_date);

    const method = custom_weights ? "POST" : "GET";
    const body = custom_weights ? JSON.stringify({ weights: custom_weights }) : undefined;

    const res = await fetch(url.toString(), {
      method,
      headers: {
        "Ortex-Api-Key": API_KEY,
        "Accept": "application/json",
        ...(body && { "Content-Type": "application/json" }),
      },
      ...(body && { body }),
    });
    if (!res.ok) throw new Error(`ORTEX ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOL 10: SHORT AVAILABILITY INDEX SCAN
// Same as availability but index-wide
// For macro short squeeze pressure screening
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool(
  "ortex_short_availability_index",
  "Index-level scan of short availability: shares available to borrow + availability % for all constituents. " +
  "Use to detect macro-level borrow squeeze setups across S&P 500 or Nasdaq 100. " +
  "When multiple names in an index show collapsing availability simultaneously, sector rotation risk rises.",
  {
    index: z.enum(["US-S 500", "US-N 100", "UK Top 100", "Europe Top 600"])
      .default("US-S 500"),
    date: z.string().optional().describe("Date YYYY-MM-DD (default: latest available)"),
    page_size: z.number().default(50),
  },
  async ({ index, date, page_size }) => {
    const data = await ortexGet(`/api/v1/index/short_availability`, {
      index,
      ...(date && { date }),
      page_size,
      format: "json",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

} // end registerTools

// ─────────────────────────────────────────────
// HTTP Server with Stateless Streamable HTTP Transport
// Same proven pattern as Quiver MCP on Railway
// ─────────────────────────────────────────────

function createRequestServer(): McpServer {
  const reqServer = new McpServer({
    name: "ORTEX-MCP",
    version: "1.0.0",
  });
  registerTools(reqServer);
  return reqServer;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || "/";

  // Health check
  if (url === "/health" || (url === "/" && req.method === "GET")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "ORTEX-MCP",
      version: "1.0.0",
      tools: 10,
      api_key_configured: API_KEY !== "TEST",
    }));
    return;
  }

  // MCP protocol version header for HEAD requests
  if (req.method === "HEAD") {
    res.writeHead(200, { "MCP-Protocol-Version": "2025-06-18" });
    res.end();
    return;
  }

  // MCP endpoint at root — stateless (new server+transport per request)
  if (url === "/" && req.method === "POST") {
    const reqServer = createRequestServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined as any,
    });
    await reqServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // MCP endpoint at /mcp — same handler, Anthropic API client hits this path
  if (url === "/mcp" && req.method === "POST") {
    const reqServer = createRequestServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined as any,
    });
    await reqServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // HEAD /mcp for protocol version check
  if (url === "/mcp" && req.method === "HEAD") {
    res.writeHead(200, { "MCP-Protocol-Version": "2025-06-18" });
    res.end();
    return;
  }

  // DELETE /mcp for session cleanup
  if (url === "/mcp" && req.method === "DELETE") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (url === "/" && req.method === "DELETE") {
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`ORTEX MCP server running on http://0.0.0.0:${PORT}`);
  console.log(`API key: ${API_KEY === "TEST" ? "TEST (trial mode)" : "configured"}`);
  console.log(`Tools: ortex_short_interest, ortex_cost_to_borrow, ortex_short_availability,`);
  console.log(`       ortex_pcr_sentiment, ortex_shares_outstanding, ortex_days_to_cover_index,`);
  console.log(`       ortex_short_interest_index, ortex_earnings_calendar, ortex_stock_scores,`);
  console.log(`       ortex_short_availability_index`);
});
