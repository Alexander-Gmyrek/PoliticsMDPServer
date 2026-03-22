#!/usr/bin/env node
/**
 * Civics MCP Server
 * Exposes tools for:
 *   - Google Civic Information API
 *   - unitedstates/congress (local data via CLI or downloaded JSON)
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

// ── Config from env ────────────────────────────────────────────────────────────
export const CONFIG = {
  GOOGLE_CIVIC_API_KEY: process.env.GOOGLE_CIVIC_API_KEY ?? "",
  CONGRESS_GOV_API_KEY: process.env.CONGRESS_GOV_API_KEY ?? "",
  CONGRESS_DATA_DIR: process.env.CONGRESS_DATA_DIR ?? "./data/congress",
  DB_JSON_PATH: process.env.DB_JSON_PATH ?? "./data/db.json",
  DB_SQLITE_PATH: process.env.DB_SQLITE_PATH ?? "./data/civics.db",
  ENABLE_DATABASE: process.env.ENABLE_DATABASE === "true",
};

// ── Server setup ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: "civics-mcp-server", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ── Register all tools ─────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    ...civicTools,
    ...congressTools,
    ...(CONFIG.ENABLE_DATABASE ? databaseTools : []),
  ];
  return { tools };
});

// ── Route tool calls ───────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (civicTools.some((t) => t.name === name)) {
      return await handleCivicTool(name, args ?? {});
    }
    if (congressTools.some((t) => t.name === name)) {
      return await handleCongressTool(name, args ?? {});
    }
    if (CONFIG.ENABLE_DATABASE && databaseTools.some((t) => t.name === name)) {
      return await handleDatabaseTool(name, args ?? {});
    }

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

// ── Start ──────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Civics MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});