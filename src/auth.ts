/**
 * OAuth 2.0 Authorization Server
 * Implements the MCP spec OAuth 2.0 flow with PKCE.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  — discovery
 *   GET  /authorize                                — authorization (auto-approves for M2M)
 *   POST /token                                    — token exchange
 *   POST /token (refresh_token grant)              — token refresh
 *   GET  /jwks                                     — public keys (for token validation)
 *
 * For machine-to-machine MCP clients, the authorization step auto-approves
 * and redirects immediately with the auth code. For a user-facing app you
 * would add a consent screen here.
 *
 * Required env:
 *   OAUTH_CLIENT_ID      — client identifier (you define this, e.g. "civics-mcp-client")
 *   OAUTH_CLIENT_SECRET  — client secret     (you define this, keep it secret)
 *   OAUTH_JWT_SECRET     — secret for signing JWT access tokens (min 32 chars)
 *   PUBLIC_URL           — public base URL of the server, e.g. https://your-app.railway.app
 */

import crypto from "crypto";
import { Request, Response, Router } from "express";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
function cfg(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function getPublicUrl() {
  return (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
}

// ── In-memory stores (swap for Redis/DB in multi-instance deployments) ────────
const authCodes = new Map<string, AuthCode>();
const refreshTokens = new Map<string, RefreshEntry>();

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expiresAt: number;
}

interface RefreshEntry {
  clientId: string;
  scope: string;
  expiresAt: number;
}

// ── JWT helpers (manual, no heavy dependency) ─────────────────────────────────
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const secret = cfg("OAUTH_JWT_SECRET");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const [header, body, sig] = token.split(".");
    const secret = cfg("OAUTH_JWT_SECRET");
    const expected = b64url(
      crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest()
    );
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function issueAccessToken(clientId: string, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: getPublicUrl(),
    sub: clientId,
    aud: "civics-mcp",
    scope,
    iat: now,
    exp: now + 3600, // 1 hour
  });
}

function issueRefreshToken(clientId: string, scope: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  refreshTokens.set(token, {
    clientId,
    scope,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  });
  return token;
}

// ── PKCE helper ───────────────────────────────────────────────────────────────
function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") {
    const hash = crypto.createHash("sha256").update(verifier).digest();
    return b64url(hash) === challenge;
  }
  // plain (not recommended but spec-compliant)
  return verifier === challenge;
}

// ── Discovery ─────────────────────────────────────────────────────────────────
router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  const base = getPublicUrl();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    jwks_uri: `${base}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
  });
});

// ── Authorization endpoint ────────────────────────────────────────────────────
router.get("/authorize", (req: Request, res: Response) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method = "S256",
    scope = "mcp",
    state,
  } = req.query as Record<string, string>;

  if (response_type !== "code") {
    return res.status(400).json({ error: "unsupported_response_type" });
  }
  if (client_id !== cfg("OAUTH_CLIENT_ID")) {
    return res.status(400).json({ error: "unauthorized_client" });
  }
  if (!code_challenge) {
    return res.status(400).json({ error: "invalid_request", error_description: "code_challenge required" });
  }

  // Auto-approve — issue auth code immediately (M2M flow)
  const code = crypto.randomBytes(16).toString("hex");
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    scope,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(redirectUrl.toString());
});

// ── Token endpoint ────────────────────────────────────────────────────────────
router.post("/token", (req: Request, res: Response) => {
  // Support both Basic auth and body params for client credentials
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    [clientId, clientSecret] = decoded.split(":");
  } else {
    clientId = req.body.client_id;
    clientSecret = req.body.client_secret;
  }

  if (clientId !== cfg("OAUTH_CLIENT_ID") || clientSecret !== cfg("OAUTH_CLIENT_SECRET")) {
    return res.status(401).json({ error: "invalid_client" });
  }

  const { grant_type, code, code_verifier, refresh_token } = req.body;

  if (grant_type === "authorization_code") {
    const entry = authCodes.get(code);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== clientId) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (!verifyPkce(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    }
    authCodes.delete(code);

    return res.json({
      access_token: issueAccessToken(clientId, entry.scope),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: issueRefreshToken(clientId, entry.scope),
      scope: entry.scope,
    });
  }

  if (grant_type === "refresh_token") {
    const entry = refreshTokens.get(refresh_token);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== clientId) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    refreshTokens.delete(refresh_token);

    return res.json({
      access_token: issueAccessToken(clientId, entry.scope),
      token_type: "Bearer",
      expires_in: 3600*24*365,
      refresh_token: issueRefreshToken(clientId, entry.scope),
      scope: entry.scope,
    });
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});

// ── JWKS (public key info — we use HMAC so this is informational only) ────────
router.get("/jwks", (_req: Request, res: Response) => {
  res.json({ keys: [] }); // HS256 is symmetric; no public keys to expose
});

// ── Middleware: validate Bearer token on MCP routes ───────────────────────────
export function requireAuth(req: Request, res: Response, next: () => void) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
  }
  const token = auth.slice(7);
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ error: "invalid_token" });
  }
  (req as Request & { oauth: Record<string, unknown> }).oauth = payload;
  next();
}

export { router as authRouter, verifyJwt };