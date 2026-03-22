# Civics MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/docs/getting-started/intro) server that gives any MCP-capable AI chatbot (Claude, Cursor, Cline, etc.) structured access to four civic data sources:

| Source | What it gives you |
|---|---|
| **Google Civic Information API** | Representatives by address, elections, voter info, polling locations |
| **ProPublica Congress API** | Members, bills, votes, committees, lobbying (live API) |
| **unitedstates/congress** | Bulk legislative data via local Python scraper |
| **Database** *(optional)* | JSON flat-file + SQLite for saving/annotating records |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Set environment variables

```bash
cp .env.example .env
# Edit .env and fill in your API keys
```

API key sources:
- **Google Civic**: [Google Cloud Console](https://console.cloud.google.com/apis/library/civicinfo.googleapis.com) — free tier available
- **ProPublica**: [ProPublica Data Store](https://www.propublica.org/datastore/api/propublica-congress-api) — free registration

### 3. (Optional) Install the unitedstates scraper

```bash
pip install unitedstates
# Then fetch data (example: current legislators)
usc-run legislators
usc-run bills --congress=118
```

### 4. Build and run

```bash
npm run build
npm start
```

Or in dev mode (no build step):
```bash
npm run dev
```

---

## Docker

### Build & run

```bash
# Copy and fill in your keys
cp .env.example .env

# Build the image
docker compose build

# Run the server (stays alive, communicates over stdio)
docker compose up -d civics-mcp
```

### Fetch congress data inside the container

The `usc-scraper` service is a one-shot helper that runs the Python scraper
and writes data into the shared `congress-data` volume:

```bash
# Fetch current legislators
docker compose run --rm usc-scraper legislators

# Fetch bills for the 118th Congress
docker compose run --rm usc-scraper bills --congress=118

# Fetch roll-call votes
docker compose run --rm usc-scraper votes --congress=118
```

Data is persisted in Docker named volumes (`congress-data`, `db-data`) and
survives container restarts.

### Enable the optional database

In your `.env`:
```
ENABLE_DATABASE=true
```
Then restart: `docker compose up -d civics-mcp`

### Useful Docker commands

```bash
# View live logs
docker compose logs -f civics-mcp

# Rebuild after code changes
docker compose build && docker compose up -d civics-mcp

# Drop into a shell inside the container
docker compose exec civics-mcp bash

# Stop everything and remove containers (volumes are preserved)
docker compose down
```

---

## Claude Desktop Integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

**Option A — Docker (recommended):**

```json
{
  "mcpServers": {
    "civics": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--mount", "source=congress-data,target=/data/congress",
        "--mount", "source=db-data,target=/data",
        "-e", "GOOGLE_CIVIC_API_KEY=your_key",
        "-e", "ENABLE_DATABASE=true",
        "civics-mcp:latest"
      ]
    }
  }
}
```

**Option B — Node directly (no Docker):**

```json
{
  "mcpServers": {
    "civics": {
      "command": "node",
      "args": ["/absolute/path/to/civics-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CIVIC_API_KEY": "your_key",
        "CONGRESS_DATA_DIR": "/absolute/path/to/data/congress",
        "ENABLE_DATABASE": "true",
        "DB_SQLITE_PATH": "/absolute/path/to/data/civics.db",
        "DB_JSON_PATH": "/absolute/path/to/data/db.json"
      }
    }
  }
}
```

---

## Available Tools

### Google Civic (`civic_*`)

| Tool | Description |
|---|---|
| `civic_get_representatives` | Elected officials for any US address |
| `civic_get_elections` | All upcoming tracked US elections |
| `civic_get_voter_info` | Polling places, drop boxes, ballot info |
| `civic_get_divisions` | Search OCD political division IDs |

### unitedstates/congress (`congress_*`)

| Tool | Description |
|---|---|
| `congress_get_current_legislators` | Current members from local data |
| `congress_get_historical_legislators` | Historical members |
| `congress_search_legislators` | Search by name/state/ID |
| `congress_get_bill` | Full bill JSON from local data |
| `congress_list_bills` | List available bills |
| `congress_get_vote` | Full vote record |
| `congress_list_votes` | List vote files |
| `congress_fetch_data` | Run the Python scraper to refresh data |

### Database (`db_*`) — requires `ENABLE_DATABASE=true`

**JSON store:**

| Tool | Description |
|---|---|
| `db_json_list_collections` | List all collections |
| `db_json_find` | Query with filters |
| `db_json_upsert` | Insert or update a record |
| `db_json_delete` | Delete by ID |
| `db_json_drop_collection` | Drop a whole collection |

**SQLite:**

| Tool | Description |
|---|---|
| `db_sql_query` | Run a SELECT query |
| `db_sql_execute` | Run INSERT/UPDATE/DELETE/DDL |
| `db_sql_list_tables` | List tables |
| `db_sql_describe_table` | Show column definitions |
| `db_sql_init_schema` | Create default civics tables |

Default SQLite tables (created by `db_sql_init_schema`):
- `saved_legislators` — bookmark members
- `saved_bills` — bookmark bills
- `saved_votes` — bookmark votes
- `notes` — freeform annotations on any entity

---

## Example Prompts for Claude

Once the server is connected:

> *"Who are my US representatives? I live at 123 Main St, Phoenix AZ 85001."*

> *"Show me the 10 most recently passed bills in the 118th Congress Senate."*

> *"Compare the voting records of senators Warren and Sanders in the 118th Congress."*

> *"Save Senator Warren's record to my database so I can reference it later."*

> *"Fetch the latest legislator data from the unitedstates/congress scraper."*

---

## Project Structure

```
civics-mcp/
├── src/
│   ├── index.ts          # MCP server entry point + config
│   ├── utils.ts          # Shared fetch + response helpers
│   └── tools/
│       ├── civic.ts      # Google Civic API tools
│       ├── propublica.ts # ProPublica Congress API tools
│       ├── congress.ts   # unitedstates/congress tools
│       └── database.ts   # Optional JSON + SQLite tools
├── data/                 # Created at runtime
│   ├── congress/         # unitedstates scraper output
│   ├── db.json           # JSON flat-file DB
│   └── civics.db         # SQLite DB
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Extending

To add a new data source, create `src/tools/mySource.ts` exporting:
- `mySourceTools: Tool[]` — MCP tool definitions
- `handleMySourceTool(name, args)` — dispatch function

Then register both in `src/index.ts`.
