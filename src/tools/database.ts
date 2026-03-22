/**
 * Optional Database Tools
 * Supports two backends:
 *   1. JSON flat-file  (DB_JSON_PATH)
 *   2. SQLite          (DB_SQLITE_PATH)
 *
 * Enable with ENABLE_DATABASE=true in your environment.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../index.js";
import { ok } from "../utils.js";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

// ── JSON store ────────────────────────────────────────────────────────────────
function readJsonDb(): Record<string, unknown[]> {
  if (!fs.existsSync(CONFIG.DB_JSON_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONFIG.DB_JSON_PATH, "utf-8"));
}

function writeJsonDb(db: Record<string, unknown[]>) {
  fs.mkdirSync(path.dirname(CONFIG.DB_JSON_PATH), { recursive: true });
  fs.writeFileSync(CONFIG.DB_JSON_PATH, JSON.stringify(db, null, 2));
}

// ── SQLite ────────────────────────────────────────────────────────────────────
let _sqlite: Database.Database | null = null;
function getSqlite(): Database.Database {
  if (!_sqlite) {
    fs.mkdirSync(path.dirname(CONFIG.DB_SQLITE_PATH), { recursive: true });
    _sqlite = new Database(CONFIG.DB_SQLITE_PATH);
    _sqlite.pragma("journal_mode = WAL");
  }
  return _sqlite;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
export const databaseTools: Tool[] = [
  // ── JSON tools ──
  {
    name: "db_json_list_collections",
    description: "List all collections (tables) in the JSON flat-file database.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "db_json_find",
    description:
      "Query records from a JSON collection. Supports simple equality filters.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name, e.g. 'saved_members'" },
        filter: {
          type: "object",
          description: "Key/value pairs to match (all conditions ANDed). Omit for all records.",
          additionalProperties: true,
        },
        limit: { type: "number", description: "Max records to return (default 100)" },
      },
      required: ["collection"],
    },
  },
  {
    name: "db_json_upsert",
    description:
      "Insert or update a record in a JSON collection. If a record with matching `id_field` exists it is replaced; otherwise it is appended.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        record: { type: "object", description: "The record to save.", additionalProperties: true },
        id_field: {
          type: "string",
          description: "Field name used as unique key for upsert (default: 'id')",
        },
      },
      required: ["collection", "record"],
    },
  },
  {
    name: "db_json_delete",
    description: "Delete a record from a JSON collection by field value.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id_field: { type: "string", description: "Field name (default: 'id')" },
        id_value: { type: "string", description: "Value to match for deletion" },
      },
      required: ["collection", "id_value"],
    },
  },
  {
    name: "db_json_drop_collection",
    description: "Delete an entire collection from the JSON database.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
      },
      required: ["collection"],
    },
  },

  // ── SQLite tools ──
  {
    name: "db_sql_query",
    description:
      "Execute a read-only SELECT query against the SQLite database. Returns rows as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SELECT statement to execute" },
        params: {
          type: "array",
          items: {},
          description: "Positional parameters (?1, ?2, ...) or named parameters",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "db_sql_execute",
    description:
      "Execute a write SQL statement (INSERT, UPDATE, DELETE, CREATE TABLE) against the SQLite database.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
        params: { type: "array", items: {} },
      },
      required: ["sql"],
    },
  },
  {
    name: "db_sql_list_tables",
    description: "List all tables in the SQLite database.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "db_sql_describe_table",
    description: "Return column definitions for a SQLite table.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
      },
      required: ["table"],
    },
  },
  {
    name: "db_sql_init_schema",
    description:
      "Create standard civics tables if they don't already exist: saved_legislators, saved_bills, saved_votes, notes.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────────────
export async function handleDatabaseTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {
    // ── JSON ──
    case "db_json_list_collections": {
      const db = readJsonDb();
      return ok(Object.keys(db).map((k) => ({ collection: k, count: db[k].length })));
    }
    case "db_json_find": {
      const { collection, filter, limit = 100 } = args as {
        collection: string;
        filter?: Record<string, unknown>;
        limit?: number;
      };
      const db = readJsonDb();
      let rows = (db[collection] ?? []) as Record<string, unknown>[];
      if (filter) {
        rows = rows.filter((r) =>
          Object.entries(filter).every(([k, v]) => r[k] === v)
        );
      }
      return ok(rows.slice(0, limit));
    }
    case "db_json_upsert": {
      const { collection, record, id_field = "id" } = args as {
        collection: string;
        record: Record<string, unknown>;
        id_field?: string;
      };
      const db = readJsonDb();
      if (!db[collection]) db[collection] = [];
      const rows = db[collection] as Record<string, unknown>[];
      const idx = rows.findIndex((r) => r[id_field] === record[id_field]);
      if (idx >= 0) rows[idx] = record;
      else rows.push(record);
      writeJsonDb(db);
      return ok({ success: true, action: idx >= 0 ? "updated" : "inserted" });
    }
    case "db_json_delete": {
      const { collection, id_field = "id", id_value } = args as {
        collection: string; id_field?: string; id_value: string;
      };
      const db = readJsonDb();
      if (!db[collection]) return ok({ success: true, deleted: 0 });
      const before = db[collection].length;
      db[collection] = (db[collection] as Record<string, unknown>[]).filter(
        (r) => r[id_field] !== id_value
      );
      writeJsonDb(db);
      return ok({ success: true, deleted: before - db[collection].length });
    }
    case "db_json_drop_collection": {
      const { collection } = args as { collection: string };
      const db = readJsonDb();
      delete db[collection];
      writeJsonDb(db);
      return ok({ success: true });
    }

    // ── SQLite ──
    case "db_sql_query": {
      const { sql, params = [] } = args as { sql: string; params?: unknown[] };
      if (!/^\s*select/i.test(sql)) throw new Error("Only SELECT is allowed in db_sql_query.");
      const stmt = getSqlite().prepare(sql);
      return ok(stmt.all(...(params as Parameters<typeof stmt.all>)));
    }
    case "db_sql_execute": {
      const { sql, params = [] } = args as { sql: string; params?: unknown[] };
      const stmt = getSqlite().prepare(sql);
      const info = stmt.run(...(params as Parameters<typeof stmt.run>));
      return ok({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
    }
    case "db_sql_list_tables": {
      const rows = getSqlite()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      return ok(rows.map((r) => r.name));
    }
    case "db_sql_describe_table": {
      const { table } = args as { table: string };
      return ok(getSqlite().prepare(`PRAGMA table_info(${table})`).all());
    }
    case "db_sql_init_schema": {
      const db = getSqlite();
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_legislators (
          bioguide_id TEXT PRIMARY KEY,
          full_name   TEXT,
          party       TEXT,
          state       TEXT,
          chamber     TEXT,
          district    TEXT,
          data        TEXT,          -- full JSON blob
          saved_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS saved_bills (
          bill_id     TEXT PRIMARY KEY,  -- e.g. "118-hr1"
          congress    INTEGER,
          bill_type   TEXT,
          number      INTEGER,
          title       TEXT,
          sponsor_id  TEXT,
          status      TEXT,
          data        TEXT,
          saved_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS saved_votes (
          vote_id     TEXT PRIMARY KEY,  -- e.g. "118-house-1-42"
          congress    INTEGER,
          chamber     TEXT,
          session     INTEGER,
          roll_call   INTEGER,
          result      TEXT,
          data        TEXT,
          saved_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notes (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT,   -- 'legislator' | 'bill' | 'vote' | 'general'
          entity_id   TEXT,
          note        TEXT,
          created_at  TEXT DEFAULT (datetime('now'))
        );
      `);
      return ok({ success: true, message: "Schema initialised." });
    }

    default:
      throw new Error(`Unknown database tool: ${name}`);
  }
}
