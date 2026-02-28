# @indiekitai/trello-autopilot

Trello bug auto-fix CLI — scans bug cards from a Trello board, invokes a coding agent (e.g. Claude Code) to fix them, then moves fixed cards to "Done" with a summary comment.

## Install

```bash
npm install -g @indiekitai/trello-autopilot
# or run directly
npx @indiekitai/trello-autopilot --board "MyBoard" --list "Bugs" --repo ./myapp
```

## Setup

Get your Trello API credentials at https://trello.com/power-ups/admin

```bash
export TRELLO_API_KEY="your-api-key"
export TRELLO_TOKEN="your-token"
```

## CLI Usage

```bash
# Fix all bugs on "Cutie" board
trello-autopilot --board "Cutie" --list "Bugs" --done "Done" --repo /path/to/repo

# Preview only (no changes)
trello-autopilot --board "Cutie" --list "Bugs" --dry-run

# JSON output for programmatic use
trello-autopilot --board "Cutie" --list "Bugs" --dry-run --json

# Custom coding agent
trello-autopilot --board "Cutie" --repo ./myapp --agent "opencode"
```

### Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--board` | `-b` | (required) | Trello board name |
| `--list` | `-l` | `"Bugs"` | Source list name |
| `--done` | `-d` | `"Done"` | Destination list for fixed cards |
| `--repo` | `-r` | cwd | Repository path |
| `--agent` | `-a` | `"claude"` | Coding agent CLI command |
| `--dry-run` | | `false` | Preview only |
| `--json` | | `false` | JSON output |
| `--help` | `-h` | | Show help |

## MCP Server

Use as an MCP tool server for AI agents:

```json
{
  "mcpServers": {
    "trello-autopilot": {
      "command": "npx",
      "args": ["@indiekitai/trello-autopilot/mcp"],
      "env": {
        "TRELLO_API_KEY": "your-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `scan_bugs` | Scan a Trello list for bug cards with comments |
| `fix_bug` | Fix a specific bug card via coding agent |
| `move_card` | Move a card to another list with optional comment |

## Programmatic API

```typescript
import { TrelloClient, scanBugs, fixBug } from "@indiekitai/trello-autopilot";

const client = new TrelloClient({
  apiKey: process.env.TRELLO_API_KEY!,
  token: process.env.TRELLO_TOKEN!,
});

const bugs = await scanBugs(client, "Cutie", "Bugs");
console.log(`Found ${bugs.length} bugs`);
```

## How It Works

1. Connects to Trello and finds the specified board/list
2. Reads each card's title, description, comments, and labels
3. Builds a prompt and invokes a coding agent (Claude Code by default)
4. On success: moves the card to "Done" and adds a comment with the fix summary
5. Reports results (or outputs JSON with `--json`)

## License

MIT
