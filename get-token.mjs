#!/usr/bin/env node
/**
 * get-token.mjs
 * Runs the OAuth 2.0 PKCE flow against the civics MCP server
 * and prints the access token.
 *
 * Usage:
 *   node get-token.mjs https://your-app.railway.app
 */

import crypto from "crypto";
import http from "http";
import { exec } from "child_process";

const BASE_URL = process.argv[2]?.replace(/\/$/, "");
if (!BASE_URL) {
  console.error("Usage: node get-token.mjs https://your-app.railway.app");
  process.exit(1);
}

const CLIENT_ID     = process.env.OAUTH_CLIENT_ID     ?? "civics-mcp-client";
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? "";
if (!CLIENT_SECRET) {
  console.error("Set OAUTH_CLIENT_SECRET env var before running.");
  process.exit(1);
}

// ── PKCE ──────────────────────────────────────────────────────────────────────
const codeVerifier  = crypto.randomBytes(32).toString("base64url");
const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

// ── Spin up a local redirect server ──────────────────────────────────────────
const REDIRECT_PORT = 9876;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;

const authCode = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    res.writeHead(200, { "Content-Type": "text/html" });
    if (code) {
      res.end("<h2>✅ Authorization successful! You can close this tab.</h2>");
      server.close();
      resolve(code);
    } else {
      res.end(`<h2>❌ Authorization failed: ${error}</h2>`);
      server.close();
      reject(new Error(`OAuth error: ${error}`));
    }
  });

  server.listen(REDIRECT_PORT, () => {
    const authUrl = new URL(`${BASE_URL}/authorize`);
    authUrl.searchParams.set("response_type",         "code");
    authUrl.searchParams.set("client_id",             CLIENT_ID);
    authUrl.searchParams.set("redirect_uri",          REDIRECT_URI);
    authUrl.searchParams.set("code_challenge",        codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("scope",                 "mcp");
    authUrl.searchParams.set("state",                 crypto.randomBytes(8).toString("hex"));

    console.log("\n🔐 Opening browser for authorization...");
    console.log(`   If it doesn't open, visit:\n   ${authUrl}\n`);

    // Open browser cross-platform
    const cmd = process.platform === "win32"
      ? `start "" "${authUrl}"`
      : process.platform === "darwin"
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
    exec(cmd);
  });
});

// ── Exchange code for token ───────────────────────────────────────────────────
console.log("🔄 Exchanging auth code for access token...");

const tokenRes = await fetch(`${BASE_URL}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type:    "authorization_code",
    code:          authCode,
    redirect_uri:  REDIRECT_URI,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: codeVerifier,
  }),
});

const tokens = await tokenRes.json();

if (!tokenRes.ok) {
  console.error("❌ Token exchange failed:", tokens);
  process.exit(1);
}

console.log("\n✅ Success!\n");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("ACCESS TOKEN (valid 1 hour):");
console.log(tokens.access_token);
console.log("\nREFRESH TOKEN (valid 30 days):");
console.log(tokens.refresh_token);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("\nAdd to claude_desktop_config.json:");
console.log(JSON.stringify({
  mcpServers: {
    civics: {
      url: `${BASE_URL}/sse`,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    },
  },
}, null, 2));
