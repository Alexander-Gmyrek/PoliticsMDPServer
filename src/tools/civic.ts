/**
 * Google Civic Information API Tools
 * Docs: https://developers.google.com/civic-information/docs/v2
 *
 * NOTE: The representativeInfoByAddress endpoint was shut down by Google in
 * April 2025. civic_get_representatives now works via a two-step approach:
 *   1. Call the Divisions API to resolve the address to OCD-IDs (state, district)
 *   2. Match those IDs against the local unitedstates/congress legislator data
 *
 * Required env: GOOGLE_CIVIC_API_KEY
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../index.js";
import { apiFetch, ok, qs } from "../utils.js";
import fs from "fs";
import path from "path";

const BASE = "https://www.googleapis.com/civicinfo/v2";

// ── Legislator data helpers ───────────────────────────────────────────────────

function legislatorsPath() {
  return path.join(CONFIG.CONGRESS_DATA_DIR, "legislators", "legislators-current.json");
}

function loadLegislators(): LegislatorRecord[] {
  const p = legislatorsPath();
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf-8")) as LegislatorRecord[];
}

/**
 * Parse a state code out of an OCD-ID.
 * e.g. "ocd-division/country:us/state:az" → "AZ"
 */
function ocdToState(ocdId: string): string | null {
  const m = ocdId.match(/\/state:([a-z]{2})/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Parse a congressional district number out of an OCD-ID.
 * e.g. "ocd-division/country:us/state:az/cd:1" → 1
 */
function ocdToDistrict(ocdId: string): number | null {
  const m = ocdId.match(/\/cd:(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
export const civicTools: Tool[] = [
  {
    name: "civic_get_representatives",
    description:
      "Look up the US federal congressional representatives (House + Senate) for any US address. " +
      "Uses the Google Civic Divisions API to resolve the address to a state and congressional district, " +
      "then matches against the local unitedstates/congress legislator dataset. " +
      "Run congress_fetch_data with task='legislators' first to populate local data.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Full US address, e.g. '1600 Pennsylvania Ave NW, Washington DC 20500'",
        },
      },
      required: ["address"],
    },
  },

  {
    name: "civic_get_elections",
    description:
      "List all upcoming US elections tracked by Google Civic. Returns election name, date, and ID for use with civic_get_voter_info.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "civic_get_voter_info",
    description:
      "Get voter information for an address: polling locations, early vote sites, drop-off locations, ballot info, and relevant election officials.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Full US address.",
        },
        election_id: {
          type: "string",
          description: "Election ID from civic_get_elections. Use '2000' for the test election.",
        },
        official_only: {
          type: "boolean",
          description: "Return only official Google-vetted data (default false).",
        },
      },
      required: ["address", "election_id"],
    },
  },

  {
    name: "civic_get_divisions",
    description:
      "Search for US political divisions (OCD-IDs) by name, e.g. a state, county, or city.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Division name to search, e.g. 'California' or 'Cook County'.",
        },
      },
      required: ["query"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────────────
export async function handleCivicTool(
  name: string,
  args: Record<string, unknown>
) {
  const key = CONFIG.GOOGLE_CIVIC_API_KEY;
  if (!key) throw new Error("GOOGLE_CIVIC_API_KEY is not set.");

  switch (name) {

    // ── Representatives: two-step lookup ─────────────────────────────────────
    case "civic_get_representatives": {
      const { address } = args as { address: string };

      // Step 1: search divisions by state name extracted from address
      // The Divisions API is a keyword search — we extract the state abbreviation
      // from the address and search for it to get the OCD state ID.
      // Then we parse the congressional district from the address if present.

      // Extract 2-letter state code from address (e.g. "Phoenix AZ 85001" → "AZ")
      const stateMatch = address.match(/\b([A-Z]{2})\b(?:\s+\d{5})?\s*$/);
      const stateAbbr = stateMatch ? stateMatch[1].toUpperCase() : null;

      if (!stateAbbr) {
        return ok({
          message:
            "Could not detect a US state abbreviation in the address. " +
            "Please include a 2-letter state code, e.g. 'Phoenix, AZ 85001'.",
          address,
        });
      }

      // Search Google Civic divisions for this state to get its OCD-ID
      const divUrl = `${BASE}/divisions${qs({ key, query: stateAbbr })}`;
      const divResult = await apiFetch<DivisionsResponse>(divUrl);
      const ocdIds = Object.keys(divResult.results ?? {});

      // Extract state + district from OCD-IDs returned by the search
      let state: string | null = null;
      let district: number | null = null;

      for (const id of ocdIds) {
        if (!state) state = ocdToState(id);
        if (!district) district = ocdToDistrict(id);
        if (state && district) break;
      }

      // If OCD search didn't resolve the state, fall back to the parsed abbreviation
      if (!state) state = stateAbbr;

      // Step 3: match against local legislator data
      const legislators = loadLegislators();

      if (legislators.length === 0) {
        return ok({
          message:
            "Local legislator data not found. " +
            "Please run the 'congress_fetch_data' tool with task='legislators' first.",
          resolved_state: state,
        });
      }

      const representatives: LegislatorRecord[] = [];

      for (const leg of legislators) {
        const term = leg.terms?.at(-1);
        if (!term) continue;
        if (term.state !== state) continue;

        if (term.type === "sen") {
          // Both senators represent the whole state
          representatives.push(leg);
        } else if (term.type === "rep") {
          if (district !== null) {
            // Match specific house district (district 0 = at-large)
            if (term.district === district || term.district === 0) {
              representatives.push(leg);
            }
          } else {
            // No district info — return all house reps for the state
            representatives.push(leg);
          }
        }
      }

      // Shape the output to be chatbot-friendly
      const shaped = representatives.map((leg) => {
        const term = leg.terms?.at(-1);
        return {
          name: leg.name?.official_full ?? `${leg.name?.first} ${leg.name?.last}`,
          role: term?.type === "sen" ? "Senator" : "Representative",
          party: term?.party,
          state: term?.state,
          district: term?.type === "rep" ? term?.district : undefined,
          url: term?.url,
          phone: term?.phone,
          office_address: term?.address,
          contact_form: term?.contact_form,
          bioguide_id: leg.id?.bioguide,
          social: leg.social_media,
        };
      });

      return ok({
        address,
        resolved_state: state,
        note: district === null
          ? "Congressional district could not be determined — showing all House members for the state. Include a zip code for better results."
          : undefined,
        representatives: shaped,
      });
    }

    // ── Elections ─────────────────────────────────────────────────────────────
    case "civic_get_elections": {
      return ok(await apiFetch(`${BASE}/elections${qs({ key })}`));
    }

    // ── Voter info ────────────────────────────────────────────────────────────
    case "civic_get_voter_info": {
      const { address, election_id, official_only } = args as {
        address: string;
        election_id: string;
        official_only?: boolean;
      };
      return ok(
        await apiFetch(
          `${BASE}/voterinfo` +
            qs({ key, address, electionId: election_id, officialOnly: official_only })
        )
      );
    }

    // ── Divisions search ──────────────────────────────────────────────────────
    case "civic_get_divisions": {
      const { query } = args as { query: string };
      return ok(await apiFetch(`${BASE}/divisions${qs({ key, query })}`));
    }

    default:
      throw new Error(`Unknown civic tool: ${name}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface DivisionsResponse {
  results?: Record<string, unknown>;
}

interface LegislatorRecord {
  id?: { bioguide?: string; [k: string]: unknown };
  name?: { first?: string; last?: string; official_full?: string };
  social_media?: unknown;
  terms?: Array<{
    type?: string;
    state?: string;
    party?: string;
    district?: number;
    url?: string;
    phone?: string;
    address?: string;
    contact_form?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}