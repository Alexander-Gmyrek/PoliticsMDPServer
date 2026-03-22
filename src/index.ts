#!/usr/bin/env node
/**
 * Civics MCP Server
 *
 * Transport auto-detection:
 *   - If PORT env var is set → HTTP/SSE mode (for Railway, cloud deployments)
 *   - Otherwise             → stdio mode (for Claude Desktop, local use)
 *
 * Tools:
 *   - Google Civic Information API
 *   - Congress.gov API v3 (bills, votes, members, committees)
 *   - unitedstates/congress-legislators (local JSON, refreshed on startup)
 *   - Optional Database layer (JSON file + SQLite)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { civicTools, handleCivicTool } from "./tools/civic.js";
import { congressTools, handleCongressTool } from "./tools/congress.js";
import { databaseTools, handleDatabaseTool } from "./tools/database.js";

// ── Config ────────────────────────────────────────────────────────────────────
export const CONFIG = {
  GOOGLE_CIVIC_API_KEY: process.env.GOOGLE_CIVIC_API_KEY ?? "",
  CONGRESS_GOV_API_KEY: process.env.CONGRESS_GOV_API_KEY ?? "",
  CONGRESS_DATA_DIR: process.env.CONGRESS_DATA_DIR ?? "./data/congress",
  DB_JSON_PATH: process.env.DB_JSON_PATH ?? "./data/db.json",
  DB_SQLITE_PATH: process.env.DB_SQLITE_PATH ?? "./data/civics.db",
  ENABLE_DATABASE: process.env.ENABLE_DATABASE === "true",
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : null,
};

// ── Build the MCP server (shared between both transports) ─────────────────────
function buildServer() {
  const server = new Server(
    { name: "civics-mcp-server", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...civicTools,
      ...congressTools,
      ...(CONFIG.ENABLE_DATABASE ? databaseTools : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (civicTools.some((t) => t.name === name))
        return await handleCivicTool(name, args ?? {});
      if (congressTools.some((t) => t.name === name))
        return await handleCongressTool(name, args ?? {});
      if (CONFIG.ENABLE_DATABASE && databaseTools.some((t) => t.name === name))
        return await handleDatabaseTool(name, args ?? {});

      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error calling ${name}: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── stdio mode ────────────────────────────────────────────────────────────────
async function startStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Civics MCP Server running on stdio");
}

// ── HTTP/SSE mode ─────────────────────────────────────────────────────────────
async function startHttp(port: number) {
  // Railway sets RAILWAY_PUBLIC_DOMAIN — use it if PUBLIC_URL not explicitly set
  if (!process.env.PUBLIC_URL && process.env.RAILWAY_PUBLIC_DOMAIN) {
    process.env.PUBLIC_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  // Dynamically import Express deps (not needed in stdio mode)
  const { default: express } = await import("express");
  const { authRouter, requireAuth } = await import("./auth.js");
  const { createSseRouter } = await import("./sse.js");

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health check (Railway uses this)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "1.1.0", transport: "sse" });
  });

  // OAuth 2.0 endpoints (no auth required — these ARE auth)
  app.use(authRouter);

  // MCP SSE endpoint (requires valid Bearer token)
  const server = buildServer();
  app.use(requireAuth, createSseRouter(server));

  app.listen(port, () => {
    console.error(`Civics MCP Server running on HTTP/SSE port ${port}`);
    console.error(`  SSE endpoint:   http://0.0.0.0:${port}/sse`);
    console.error(`  OAuth discovery: http://0.0.0.0:${port}/.well-known/oauth-authorization-server`);
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  if (CONFIG.PORT) {
    await startHttp(CONFIG.PORT);
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});