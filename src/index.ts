import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type RequestHandler } from "express";
import { z } from "zod";

import { DataDiveClient, DataDiveApiError } from "./adapter/client.js";
import {
  listNiches,
  getKeywords,
  getCompetitors,
  getRankingJuices,
  getKeywordRoots,
  listRankRadars,
  getRankRadar,
  getDiveStatus,
  createDive,
  createRankRadar,
  triggerAiCopywriter,
  deleteNiche,
  deleteRankRadar,
} from "./adapter/endpoints.js";
import {
  toUniversalEnvelope,
  toErrorEnvelope,
  transformNiche,
  transformKeyword,
  transformCompetitor,
  transformNicheStatistics,
  transformRankingJuices,
  transformKeywordRoot,
  transformRankTracker,
  transformKeywordRankHistory,
  transformPassthrough,
} from "./adapter/transformer.js";
import { extractPagination } from "./utils/pagination.js";

const client = new DataDiveClient();
function createMcpServer(): McpServer {
const server = new McpServer({
  name: "datadive-adapter",
  version: "1.0.0",
});

function errorResult(err: unknown) {
  const envelope =
    err instanceof DataDiveApiError
      ? toErrorEnvelope(
          `datadive_${err.httpStatus}`,
          err.message,
          err.httpStatus
        )
      : toErrorEnvelope(
          "adapter_error",
          err instanceof Error ? err.message : "Unknown error"
        );
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }], isError: true };
}

// --- 1. List Niches ---
server.tool(
  "datadive_list_niches",
  "List all niches configured in DataDive. Returns niche IDs, hero keywords, labels, and marketplace.",
  { page: z.number().int().optional(), page_size: z.number().int().optional() },
  async ({ page, page_size }) => {
    try {
      const raw = await listNiches(client, { page, pageSize: page_size });
      const data = raw.data.map(transformNiche);
      const envelope = toUniversalEnvelope("niche_summary", data, {
        pagination: extractPagination(raw),
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 2. Get Keywords ---
server.tool(
  "datadive_get_keywords",
  "Get the master keyword list for a niche including search volume, relevancy, organic ranks, and sponsored ranks.",
  { niche_id: z.string() },
  async ({ niche_id }) => {
    try {
      const raw = await getKeywords(client, niche_id);
      const data = raw.data.keywords.map(transformKeyword);
      const envelope = toUniversalEnvelope("keyword_ranking", data);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 3. Get Competitors ---
server.tool(
  "datadive_get_competitors",
  "Get competitor ASINs and niche statistics for a given niche.",
  { niche_id: z.string() },
  async ({ niche_id }) => {
    try {
      const raw = await getCompetitors(client, niche_id);
      const competitors = raw.data.competitors.map(transformCompetitor);
      const statistics = transformNicheStatistics(raw.data);
      const envelope = toUniversalEnvelope("competitor", {
        statistics,
        competitors,
      }, { marketplace: raw.data.marketplace });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 4. Get Ranking Juices ---
server.tool(
  "datadive_get_ranking_juices",
  "Get ranking factor analysis for a niche showing what drives organic rank.",
  { niche_id: z.string() },
  async ({ niche_id }) => {
    try {
      const raw = await getRankingJuices(client, niche_id);
      const data = transformRankingJuices(raw.data);
      const envelope = toUniversalEnvelope("ranking_juice", data);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 5. Get Keyword Roots ---
server.tool(
  "datadive_get_keyword_roots",
  "Get keyword root groupings for a niche showing how keywords cluster together.",
  { niche_id: z.string() },
  async ({ niche_id }) => {
    try {
      const raw = await getKeywordRoots(client, niche_id);
      const data = raw.data.keywords.map(transformKeywordRoot);
      const envelope = toUniversalEnvelope("keyword_root", data);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 6. List Rank Radars ---
server.tool(
  "datadive_list_rank_radars",
  "List all Rank Radar keyword trackers. Returns ASIN, keyword count, and top 10/50 ranking summary metrics.",
  { page: z.number().int().optional(), page_size: z.number().int().optional() },
  async ({ page, page_size }) => {
    try {
      const raw = await listRankRadars(client, { page, pageSize: page_size });
      const inner = raw.data;
      const data = inner.data.map(transformRankTracker);
      const envelope = toUniversalEnvelope("rank_tracker", data, {
        pagination: extractPagination(inner),
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 7. Get Rank Radar ---
server.tool(
  "datadive_get_rank_radar",
  "Get keyword ranking data for a specific Rank Radar tracker including historical rank positions and search volume. Returns ASIN and tracker metadata alongside keyword ranks. Defaults to last 30 days if dates not specified.",
  {
    rank_radar_id: z.string().describe("The Rank Radar tracker ID"),
    start_date: z.string().optional().describe("Start date (ISO 8601, e.g. 2026-03-14). Defaults to 30 days ago."),
    end_date: z.string().optional().describe("End date (ISO 8601, e.g. 2026-04-13). Defaults to today."),
  },
  async ({ rank_radar_id, start_date, end_date }) => {
    try {
      const [rankRaw, listRaw] = await Promise.all([
        getRankRadar(client, rank_radar_id, { startDate: start_date, endDate: end_date }),
        listRankRadars(client, { pageSize: 300 }),
      ]);
      const keywords = rankRaw.data.map(transformKeywordRankHistory);
      const trackerRaw = listRaw.data.data.find((t) => t.id === rank_radar_id);
      const tracker = trackerRaw ? transformRankTracker(trackerRaw) : null;
      const envelope = toUniversalEnvelope("keyword_rank_history", { tracker, keywords }, {
        marketplace: tracker?.marketplace ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 8. Get Dive Status ---
server.tool(
  "datadive_get_dive_status",
  "Check the status of a Niche Dive research job.",
  { dive_id: z.string() },
  async ({ dive_id }) => {
    try {
      const raw = await getDiveStatus(client, dive_id);
      const envelope = toUniversalEnvelope("dive_status", transformPassthrough(raw));
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =====================
// Phase 2: Write Tools
// =====================

// --- 9. Create Dive ---
server.tool(
  "datadive_create_dive",
  "Create a new Niche Dive research job for an ASIN. Kicks off keyword and competitor research. Use datadive_get_dive_status to check progress.",
  {
    keyword: z.string().describe("The search term / hero keyword to research"),
    asin: z.string().describe("The Amazon ASIN to dive on"),
    marketplace: z.string().optional().describe("Amazon marketplace (default: com)"),
    number_of_competitors: z.number().int().min(2).optional().describe("Number of competitors to analyze (default: 17, min: 2)"),
  },
  async ({ keyword, asin, marketplace, number_of_competitors }) => {
    try {
      const raw = await createDive(client, { keyword, asin, marketplace, numberOfCompetitors: number_of_competitors });
      const envelope = toUniversalEnvelope("dive_created", {
        dive_id: raw.data.diveId,
        estimated_completion: raw.data.estimatedCompletionDate,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 10. Create Rank Radar ---
server.tool(
  "datadive_create_rank_radar",
  "Create a new Rank Radar keyword tracker for an ASIN within a niche. Tracks keyword ranking positions over time.",
  {
    asin: z.string().describe("The Amazon ASIN to track"),
    niche_id: z.string().describe("The DataDive niche ID"),
    marketplace: z.string().optional().describe("Amazon marketplace (default: com)"),
    number_of_keywords: z.number().int().min(1).optional().describe("Number of keywords to track (default: 50)"),
  },
  async ({ asin, niche_id, marketplace, number_of_keywords }) => {
    try {
      const raw = await createRankRadar(client, { asin, nicheId: niche_id, marketplace, numberOfKeywords: number_of_keywords });
      const envelope = toUniversalEnvelope("rank_radar_created", {
        rank_radar_id: raw.data.rankRadarId,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 11. AI Copywriter ---
server.tool(
  "datadive_ai_copywriter",
  "Generate optimized listing copy for a niche using AI. Returns title, bullets, and description optimized for ranking juice.",
  {
    niche_id: z.string().describe("The DataDive niche ID"),
    prompt: z.enum(["cosmo", "ranking-juice", "nlp", "cosmo-rufus"]).optional().describe("Copywriting strategy (default: ranking-juice)"),
  },
  async ({ niche_id, prompt }) => {
    try {
      const raw = await triggerAiCopywriter(client, niche_id, prompt);
      const envelope = toUniversalEnvelope("ai_copywriter", {
        title: raw.data.title,
        bullets: raw.data.bullets,
        description: raw.data.description,
      });
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 12. Delete Niche ---
server.tool(
  "datadive_delete_niche",
  "Delete a niche and all its associated research data. This action cannot be undone.",
  { niche_id: z.string().describe("The DataDive niche ID to delete") },
  async ({ niche_id }) => {
    try {
      const raw = await deleteNiche(client, niche_id);
      const envelope = toUniversalEnvelope("niche_deleted", transformPassthrough(raw));
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

// --- 13. Delete Rank Radar ---
server.tool(
  "datadive_delete_rank_radar",
  "Delete a Rank Radar keyword tracker. This action cannot be undone.",
  { rank_radar_id: z.string().describe("The Rank Radar tracker ID to delete") },
  async ({ rank_radar_id }) => {
    try {
      const raw = await deleteRankRadar(client, rank_radar_id);
      const envelope = toUniversalEnvelope("rank_radar_deleted", transformPassthrough(raw));
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

  return server;
}

// ---------------------------------------------------------------------------
// Clerk OAuth token validation (hits Clerk /oauth/userinfo per request)
// ---------------------------------------------------------------------------
async function validateClerkToken(
  bearer: string,
  clerkIssuer: string,
): Promise<{ ok: true; email: string } | { ok: false; status: number; reason?: string }> {
  try {
    const response = await fetch(`${clerkIssuer}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json()) as { email?: string; email_address?: string } | null;
    if (!body) return { ok: false, status: 502, reason: "userinfo_malformed" };
    return { ok: true, email: body.email || body.email_address || "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return { ok: false, status: 502, reason: `clerk_unreachable: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// HTTP transport (TRANSPORT=http) — used in Railway / Cowork deployment
// ---------------------------------------------------------------------------
async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const clerkIssuer = process.env.CLERK_OAUTH_ISSUER ?? "https://clerk.sitruna.com";
  const emailDomain = (process.env.MCP_OAUTH_EMAIL_DOMAIN ?? "sitruna.com").toLowerCase();
  const oauthEnabled = process.env.MCP_OAUTH_ENABLED === "true";

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // CORS — required for Anthropic web connectors negotiating OAuth from the browser
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
    next();
  });

  // Auth middleware — validates Clerk OAuth bearer token when MCP_OAUTH_ENABLED=true
  const authMiddleware: RequestHandler = async (req, res, next) => {
    if (!oauthEnabled) { next(); return; }
    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    const token = match ? match[1] : null;
    if (!token) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      res.set("WWW-Authenticate", `Bearer realm="mcp", resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing bearer" }, id: null });
      return;
    }
    const result = await validateClerkToken(token, clerkIssuer);
    if (!result.ok) {
      res.status(result.status === 502 ? 502 : 401).json({ jsonrpc: "2.0", error: { code: -32001, message: `Unauthorized: ${result.reason ?? "invalid_token"}` }, id: null });
      return;
    }
    const email = String(result.email).toLowerCase();
    if (!email.endsWith(`@${emailDomain}`)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: `Forbidden: ${emailDomain} email required` }, id: null });
      return;
    }
    next();
  };

  // Liveness probe — unauthenticated, used by Railway healthcheck
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "datadive-adapter", version: "1.0.0" }));
  app.get("/sse", (_req, res) => res.send("ok"));

  // OAuth 2.0 Protected Resource Metadata (RFC 9728) — required by Anthropic connector
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    res.json({
      resource: `${proto}://${host}`,
      authorization_servers: [clerkIssuer],
      scopes_supported: ["openid", "profile", "email"],
      bearer_methods_supported: ["header"],
    });
  });

  // OAuth 2.1 authorization server metadata
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: clerkIssuer,
      authorization_endpoint: `${clerkIssuer}/oauth/authorize`,
      token_endpoint: `${clerkIssuer}/oauth/token`,
      userinfo_endpoint: `${clerkIssuer}/oauth/userinfo`,
      jwks_uri: `${clerkIssuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
  });

  // Stateless MCP handler — fresh McpServer + transport per request
  const handleMcp: RequestHandler = async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };

  app.post("/mcp", authMiddleware, handleMcp);
  app.get("/mcp", authMiddleware, handleMcp);
  app.delete("/mcp", authMiddleware, handleMcp);

  app.listen(port, () => {
    console.error(`[datadive-adapter] HTTP transport listening on port ${port} (oauth=${oauthEnabled})`);
  });
}

// ---------------------------------------------------------------------------
// Stdio transport (TRANSPORT=stdio, default for local dev)
// ---------------------------------------------------------------------------
async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => setTimeout(() => process.exit(0), 2_000).unref();
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);
}

async function main(): Promise<void> {
  const transport = (process.env.TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
