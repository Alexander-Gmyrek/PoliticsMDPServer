/**
 * Congress Tools
 *
 * Two data sources:
 *   1. Local JSON (unitedstates/congress-legislators) — legislators only
 *      Refreshed at container startup and via congress_fetch_data.
 *
 *   2. Congress.gov API v3 — bills, votes, amendments, summaries (live)
 *      Docs: https://api.congress.gov/
 *      Required env: CONGRESS_GOV_API_KEY
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../index.js";
import { apiFetch, ok, qs } from "../utils.js";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CGOV = "https://api.congress.gov/v3";

function cgov(endpoint: string, params: Record<string, unknown> = {}) {
  const key = CONFIG.CONGRESS_GOV_API_KEY;
  if (!key) throw new Error("CONGRESS_GOV_API_KEY is not set.");
  return `${CGOV}${endpoint}${qs({ ...params, api_key: key, format: "json" })}`;
}

// ── Local legislator helpers ──────────────────────────────────────────────────
function dataDir(...parts: string[]) {
  return path.join(CONFIG.CONGRESS_DATA_DIR, ...parts);
}

function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Data file not found: ${filePath}. Run congress_fetch_data first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ── Tool definitions ──────────────────────────────────────────────────────────
export const congressTools: Tool[] = [

  // ── Local legislator tools ─────────────────────────────────────────────────
  {
    name: "congress_get_current_legislators",
    description:
      "Return current US legislators from the local dataset. Filter by state, party, or chamber.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "2-letter state code, e.g. 'AZ'" },
        party: { type: "string", description: "'Democrat', 'Republican', or 'Independent'" },
        chamber: { type: "string", enum: ["senate", "house"] },
      },
    },
  },
  {
    name: "congress_get_historical_legislators",
    description: "Return historical US legislators (no longer serving) from the local dataset.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        name_search: { type: "string", description: "Partial name match" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "congress_search_legislators",
    description: "Search current legislators by name, state, or bioguide ID.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "congress_fetch_data",
    description:
      "Download and refresh local legislator/committee data from unitedstates.github.io. " +
      "Supported tasks: 'legislators', 'committee_membership'.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          enum: ["legislators", "committee_membership"],
        },
      },
      required: ["task"],
    },
  },

  // ── Congress.gov API — Bills ───────────────────────────────────────────────
  {
    name: "congress_list_bills",
    description:
      "List bills from the Congress.gov API. Filter by congress number, bill type, or keyword search.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number", description: "Congress number, e.g. 119" },
        bill_type: {
          type: "string",
          enum: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"],
        },
        offset: { type: "number", description: "Pagination offset (default 0)" },
        limit: { type: "number", description: "Results per page, max 250 (default 20)" },
      },
    },
  },
  {
    name: "congress_get_bill",
    description: "Get full details for a specific bill from Congress.gov including sponsors, status, and summaries.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number", description: "Congress number, e.g. 119" },
        bill_type: {
          type: "string",
          enum: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"],
        },
        bill_number: { type: "number" },
      },
      required: ["congress", "bill_type", "bill_number"],
    },
  },
  {
    name: "congress_get_bill_actions",
    description: "Get the full action history for a bill (committee referrals, floor votes, presidential actions).",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number" },
        bill_type: { type: "string", enum: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"] },
        bill_number: { type: "number" },
        limit: { type: "number", description: "Max actions to return (default 20)" },
      },
      required: ["congress", "bill_type", "bill_number"],
    },
  },
  {
    name: "congress_get_bill_cosponsors",
    description: "List all cosponsors for a bill.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number" },
        bill_type: { type: "string", enum: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"] },
        bill_number: { type: "number" },
      },
      required: ["congress", "bill_type", "bill_number"],
    },
  },
  {
    name: "congress_search_bills",
    description: "Full-text search for bills by keyword using the Congress.gov API.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term, e.g. 'climate change' or 'healthcare'" },
        congress: { type: "number", description: "Limit to a specific congress (optional)" },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number" },
      },
      required: ["query"],
    },
  },

  // ── Congress.gov API — Votes ───────────────────────────────────────────────
  {
    name: "congress_list_votes",
    description: "List recent roll-call votes from Congress.gov for a given congress and chamber.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number", description: "Congress number, e.g. 119" },
        chamber: { type: "string", enum: ["senate", "house"] },
        offset: { type: "number" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["congress", "chamber"],
    },
  },
  {
    name: "congress_get_vote",
    description: "Get details for a specific roll-call vote from Congress.gov.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number" },
        chamber: { type: "string", enum: ["senate", "house"] },
        session: { type: "number", description: "Session number (1 or 2)" },
        vote_number: { type: "number" },
      },
      required: ["congress", "chamber", "session", "vote_number"],
    },
  },

  // ── Congress.gov API — Members ─────────────────────────────────────────────
  {
    name: "congress_get_member",
    description: "Get detailed info for a Congress member by bioguide ID from Congress.gov, including sponsored bills and committee assignments.",
    inputSchema: {
      type: "object",
      properties: {
        bioguide_id: { type: "string", description: "Bioguide ID, e.g. 'K000377'" },
      },
      required: ["bioguide_id"],
    },
  },
  {
    name: "congress_get_member_sponsored_legislation",
    description: "Get bills sponsored by a specific Congress member.",
    inputSchema: {
      type: "object",
      properties: {
        bioguide_id: { type: "string" },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number" },
      },
      required: ["bioguide_id"],
    },
  },

  // ── Congress.gov API — Committees ──────────────────────────────────────────
  {
    name: "congress_list_committees",
    description: "List congressional committees from Congress.gov.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number" },
        chamber: { type: "string", enum: ["senate", "house", "joint"] },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },

  // ── Congress.gov API — Amendments ──────────────────────────────────────────
  {
    name: "congress_list_amendments",
    description: "List amendments for a specific bill from Congress.gov.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "number" },
        bill_type: { type: "string", enum: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"] },
        bill_number: { type: "number" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["congress", "bill_type", "bill_number"],
    },
  },

  // ── Congress.gov API — Congressional Record ────────────────────────────────
  {
    name: "congress_search_record",
    description: "Search the Congressional Record by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────────────
export async function handleCongressTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {

    // ── Local legislator tools ───────────────────────────────────────────────
    case "congress_get_current_legislators": {
      const { state, party, chamber } = args as {
        state?: string; party?: string; chamber?: string;
      };
      let data = readJson(dataDir("legislators", "legislators-current.json")) as LegislatorRecord[];
      if (state) data = data.filter((l) => l.terms.at(-1)?.state === state.toUpperCase());
      if (party) data = data.filter((l) => l.terms.at(-1)?.party?.toLowerCase() === party.toLowerCase());
      if (chamber) {
        const t = chamber === "senate" ? "sen" : "rep";
        data = data.filter((l) => l.terms.at(-1)?.type === t);
      }
      return ok(data);
    }

    case "congress_get_historical_legislators": {
      const { state, name_search, limit = 50 } = args as {
        state?: string; name_search?: string; limit?: number;
      };
      let data = readJson(dataDir("legislators", "legislators-historical.json")) as LegislatorRecord[];
      if (state) data = data.filter((l) => l.terms.some((t) => t.state === state.toUpperCase()));
      if (name_search) {
        const q = name_search.toLowerCase();
        data = data.filter((l) =>
          [l.name?.first, l.name?.last, l.name?.official_full]
            .filter(Boolean)
            .some((n) => n!.toLowerCase().includes(q))
        );
      }
      return ok(data.slice(0, limit as number));
    }

    case "congress_search_legislators": {
      const { query, limit = 20 } = args as { query: string; limit?: number };
      const data = readJson(dataDir("legislators", "legislators-current.json")) as LegislatorRecord[];
      const q = query.toLowerCase();
      const results = data.filter((l) => {
        const nameMatch = [l.name?.first, l.name?.last, l.name?.official_full]
          .filter(Boolean)
          .some((n) => n!.toLowerCase().includes(q));
        const stateMatch = l.terms.at(-1)?.state?.toLowerCase().includes(q);
        const bioguideMatch = l.id?.bioguide?.toLowerCase().includes(q);
        return nameMatch || stateMatch || bioguideMatch;
      });
      return ok(results.slice(0, limit as number));
    }

    case "congress_fetch_data": {
      const { task } = args as { task: string };
      const BASE_URL = "https://unitedstates.github.io/congress-legislators";
      const downloads: Record<string, { url: string; dest: string }[]> = {
        legislators: [
          {
            url: `${BASE_URL}/legislators-current.json`,
            dest: path.join(CONFIG.CONGRESS_DATA_DIR, "legislators", "legislators-current.json"),
          },
          {
            url: `${BASE_URL}/legislators-historical.json`,
            dest: path.join(CONFIG.CONGRESS_DATA_DIR, "legislators", "legislators-historical.json"),
          },
        ],
        committee_membership: [
          {
            url: `${BASE_URL}/committee-membership-current.json`,
            dest: path.join(CONFIG.CONGRESS_DATA_DIR, "legislators", "committee-membership-current.json"),
          },
          {
            url: `${BASE_URL}/committees-current.json`,
            dest: path.join(CONFIG.CONGRESS_DATA_DIR, "legislators", "committees-current.json"),
          },
        ],
      };
      const targets = downloads[task];
      if (!targets) {
        throw new Error(`Task '${task}' not supported. Supported: ${Object.keys(downloads).join(", ")}.`);
      }
      const results = [];
      for (const { url, dest } of targets) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          const { stdout, stderr } = await execFileAsync("curl", ["-fsSL", url, "-o", dest], { timeout: 60_000 });
          results.push({ url, dest, status: "success", stdout, stderr });
        } catch (err) {
          const e = err as { message?: string };
          results.push({ url, dest, status: "error", error: e.message });
        }
      }
      return ok({ task, results });
    }

    // ── Congress.gov API — Bills ─────────────────────────────────────────────
    case "congress_list_bills": {
      const { congress, bill_type, offset = 0, limit = 20 } = args as {
        congress?: number; bill_type?: string; offset?: number; limit?: number;
      };
      const endpoint = congress
        ? bill_type
          ? `/bill/${congress}/${bill_type}`
          : `/bill/${congress}`
        : `/bill`;
      return ok(await apiFetch(cgov(endpoint, { offset, limit })));
    }

    case "congress_get_bill": {
      const { congress, bill_type, bill_number } = args as {
        congress: number; bill_type: string; bill_number: number;
      };
      return ok(await apiFetch(cgov(`/bill/${congress}/${bill_type}/${bill_number}`)));
    }

    case "congress_get_bill_actions": {
      const { congress, bill_type, bill_number, limit = 20 } = args as {
        congress: number; bill_type: string; bill_number: number; limit?: number;
      };
      return ok(await apiFetch(cgov(`/bill/${congress}/${bill_type}/${bill_number}/actions`, { limit })));
    }

    case "congress_get_bill_cosponsors": {
      const { congress, bill_type, bill_number } = args as {
        congress: number; bill_type: string; bill_number: number;
      };
      return ok(await apiFetch(cgov(`/bill/${congress}/${bill_type}/${bill_number}/cosponsors`)));
    }

    case "congress_search_bills": {
      const { query, congress, limit = 20, offset = 0 } = args as {
        query: string; congress?: number; limit?: number; offset?: number;
      };
      // Congress.gov search uses the /bill endpoint with a query param
      const params: Record<string, unknown> = { query, limit, offset };
      if (congress) params.congress = congress;
      return ok(await apiFetch(cgov(`/bill`, params)));
    }

    // ── Congress.gov API — Votes ─────────────────────────────────────────────
    case "congress_list_votes": {
      const { congress, chamber, offset = 0, limit = 20 } = args as {
        congress: number; chamber: string; offset?: number; limit?: number;
      };
      return ok(await apiFetch(cgov(`/${chamber}-vote/${congress}`, { offset, limit })));
    }

    case "congress_get_vote": {
      const { congress, chamber, session, vote_number } = args as {
        congress: number; chamber: string; session: number; vote_number: number;
      };
      return ok(await apiFetch(cgov(`/${chamber}-vote/${congress}/${session}/${vote_number}`)));
    }

    // ── Congress.gov API — Members ───────────────────────────────────────────
    case "congress_get_member": {
      const { bioguide_id } = args as { bioguide_id: string };
      return ok(await apiFetch(cgov(`/member/${bioguide_id}`)));
    }

    case "congress_get_member_sponsored_legislation": {
      const { bioguide_id, limit = 20, offset = 0 } = args as {
        bioguide_id: string; limit?: number; offset?: number;
      };
      return ok(await apiFetch(cgov(`/member/${bioguide_id}/sponsored-legislation`, { limit, offset })));
    }

    // ── Congress.gov API — Committees ────────────────────────────────────────
    case "congress_list_committees": {
      const { congress, chamber, limit = 20 } = args as {
        congress?: number; chamber?: string; limit?: number;
      };
      const endpoint = congress
        ? chamber ? `/committee/${congress}/${chamber}` : `/committee/${congress}`
        : `/committee`;
      return ok(await apiFetch(cgov(endpoint, { limit })));
    }

    // ── Congress.gov API — Amendments ────────────────────────────────────────
    case "congress_list_amendments": {
      const { congress, bill_type, bill_number, limit = 20 } = args as {
        congress: number; bill_type: string; bill_number: number; limit?: number;
      };
      return ok(await apiFetch(cgov(`/bill/${congress}/${bill_type}/${bill_number}/amendments`, { limit })));
    }

    // ── Congress.gov API — Congressional Record ──────────────────────────────
    case "congress_search_record": {
      const { query, limit = 20 } = args as { query: string; limit?: number };
      return ok(await apiFetch(cgov(`/congressional-record`, { query, limit })));
    }

    default:
      throw new Error(`Unknown congress tool: ${name}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface LegislatorRecord {
  id?: { bioguide?: string; govtrack?: number; [k: string]: unknown };
  name?: { first?: string; last?: string; official_full?: string };
  terms: Array<{ type?: string; state?: string; party?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}