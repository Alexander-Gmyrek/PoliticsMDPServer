/**
 * SSE (Server-Sent Events) transport for MCP over HTTP.
 * Implements the MCP SSE transport spec.
 *
 * Routes:
 *   GET  /sse      — client connects here, receives SSE stream
 *   POST /message  — client posts JSON-RPC messages here
 */

import { Request, Response, Router } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export function createSseRouter(server: Server) {
  const router = Router();

  // Active SSE transports keyed by session ID
  const transports = new Map<string, SSEServerTransport>();

  // GET /sse — open SSE stream
  router.get("/sse", async (req: Request, res: Response) => {
    console.error(`[SSE] New client connected from ${req.ip}`);

    const transport = new SSEServerTransport("/message", res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    res.on("close", () => {
      console.error(`[SSE] Client disconnected: ${sessionId}`);
      transports.delete(sessionId);
    });

    await server.connect(transport);
  });

  // POST /message — receive JSON-RPC from client
  router.post("/message", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      return res.status(404).json({ error: "Session not found" });
    }

    await transport.handlePostMessage(req, res);
  });

  return router;
}