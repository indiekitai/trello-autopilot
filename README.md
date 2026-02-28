# @indiekitai/trello-autopilot

Trello bug auto-fix CLI — scans bug cards from a Trello board, invokes a coding agent (e.g. Claude Code) to fix them, runs tests to verify, manages git branches/PRs, and moves fixed cards to "Done" with a summary comment.

## Features (v0.2.0)

- **Test verification** — auto-runs `npm test` or `pytest` after fix; failed tests → card gets "fix-failed" label + failure details comment
- **Git integration** — creates `fix/card-{id}` branches, generates diff summaries, `--pr` mode for pull requests via `gh` CLI, `git blame` analysis
- **Priority sorting** — processes cards by label priority: critical > high > medium > low
- **Smart filtering** — `--label critical` to fix only specific labels, `--limit N` to cap count
- **Failure handling** — failed fixes get "needs-human" label + detailed comment with suggestions
- **Retry** — `--retry` to re-attempt previously failed cards (fix-failed / needs-human)
- **Reporting** — summary report with fix/fail/skip counts and timing; `--json` for structured output; `--webhook` to POST results

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
trello-autopilot --board "Cutie" --repo /path/to/repo

# Fix only critical bugs, max 3
trello-autopilot --board "Cutie" --label critical --limit 3

# Create PRs instead of pushing to main
trello-autopilot --board "Cutie" --repo ./myapp --pr

# Retry previously failed cards
trello-autopilot --board "Cutie" --repo ./myapp --retry

# Custom test command
trello-autopilot --board "Cutie" --repo ./myapp --test-command "make test"

# JSON output + webhook notification
trello-autopilot --board "Cutie" --json --webhook https://hooks.slack.com/xxx

# Preview only (no changes)
trello-autopilot --board "Cutie" --dry-run
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
| `--limit` | `-n` | all | Max cards to process |
| `--label` | | all | Only fix cards with this label |
| `--pr` | | `false` | Create PR via `gh` CLI |
| `--retry` | | `false` | Retry fix-failed/needs-human cards |
| `--test-command` | `-t` | auto-detect | Custom test command |
| `--webhook` | `-w` | | POST results to URL |
| `--help` | `-h` | | Show help |

## How It Works

1. Connects to Trello and finds the specified board/list
2. Sorts cards by priority labels (critical > high > medium > low)
3. Applies filters (`--label`, `--limit`, `--retry`)
4. For each card:
   - Creates a git branch `fix/card-{id}`
   - Runs `git blame` analysis for context
   - Invokes the coding agent with card details as prompt
   - Runs tests (`npm test` / `pytest` / custom command)
   - **If tests pass:** commits, pushes (or creates PR with `--pr`), moves card to Done
   - **If tests fail:** adds "fix-failed" label + failure comment, does NOT move card
   - **If agent fails:** adds "needs-human" label + detailed failure comment
5. Outputs summary report (or JSON with `--json`)
6. Sends webhook if `--webhook` is configured

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
| `scan_bugs` | Scan a Trello list for bug cards (with priority sorting & filtering) |
| `fix_bug` | Fix a specific bug card with test verification and git integration |
| `move_card` | Move a card to another list with optional comment |
| `retry_failed` | Retry previously failed cards (fix-failed/needs-human) |
| `get_report` | Run autopilot and return a structured report |

## Programmatic API

```typescript
import {
  TrelloClient,
  scanBugs,
  fixBug,
  sortByPriority,
  filterByLabel,
  generateReport,
} from "@indiekitai/trello-autopilot";

const client = new TrelloClient({
  apiKey: process.env.TRELLO_API_KEY!,
  token: process.env.TRELLO_TOKEN!,
});

let bugs = await scanBugs(client, "Cutie", "Bugs");
bugs = sortByPriority(bugs);
bugs = filterByLabel(bugs, "critical");
console.log(`Found ${bugs.length} critical bugs`);
```

## Labels Used

| Label | Meaning |
|-------|---------|
| `critical` / `high` / `medium` / `low` | Priority for sorting |
| `fix-failed` | Auto-fix was applied but tests failed |
| `needs-human` | Auto-fix failed completely, needs manual intervention |

## License

MIT
