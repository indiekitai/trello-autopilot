#!/usr/bin/env node
/**
 * trello-autopilot CLI — v0.2.0
 */

import { parseArgs } from "node:util";
import { run, formatReport } from "./core.js";

const { values } = parseArgs({
  options: {
    board: { type: "string", short: "b" },
    list: { type: "string", short: "l", default: "Bugs" },
    done: { type: "string", short: "d", default: "Done" },
    repo: { type: "string", short: "r" },
    agent: { type: "string", short: "a", default: "claude" },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    limit: { type: "string", short: "n" },
    label: { type: "string" },
    pr: { type: "boolean", default: false },
    retry: { type: "boolean", default: false },
    webhook: { type: "string", short: "w" },
    "test-command": { type: "string", short: "t" },
  },
  strict: true,
});

if (values.help || !values.board) {
  console.log(`
trello-autopilot — Trello bug auto-fix CLI (v0.2.0)

Usage:
  trello-autopilot --board <name> [options]

Options:
  -b, --board <name>      Trello board name (required)
  -l, --list <name>       Bug list name (default: "Bugs")
  -d, --done <name>       Done list name (default: "Done")
  -r, --repo <path>       Repository path (default: cwd)
  -a, --agent <cmd>       Coding agent command (default: "claude")
      --dry-run           Preview only, don't fix or move cards
      --json              Output results as JSON
  -h, --help              Show this help

  Priority & Filtering:
  -n, --limit <N>         Max number of cards to process
      --label <name>      Only fix cards with this label (e.g. "critical")
      --retry             Retry previously failed cards (fix-failed/needs-human)

  Git Integration:
      --pr                Create PR instead of pushing to main (uses gh CLI)
  -t, --test-command <cmd>  Custom test command (auto-detects npm test / pytest)

  Reporting:
  -w, --webhook <url>     POST results to webhook URL after completion

Environment:
  TRELLO_API_KEY          Trello API key
  TRELLO_TOKEN            Trello token

Features:
  • Test verification — runs tests after fix; failed tests → "fix-failed" label
  • Git integration — creates fix/card-{id} branches, git diff summary, PR mode
  • Priority sorting — critical > high > medium > low labels
  • Failure handling — "needs-human" label + detailed comment on failure
  • Reporting — summary report with counts and timing

Examples:
  # Fix all bugs
  trello-autopilot --board "Cutie" --repo ./myapp

  # Fix only critical bugs, max 3
  trello-autopilot --board "Cutie" --label critical --limit 3

  # Create PRs instead of pushing to main
  trello-autopilot --board "Cutie" --repo ./myapp --pr

  # Retry previously failed cards
  trello-autopilot --board "Cutie" --repo ./myapp --retry

  # JSON output + webhook
  trello-autopilot --board "Cutie" --json --webhook https://hooks.slack.com/xxx
`);
  process.exit(values.help ? 0 : 1);
}

try {
  const report = await run({
    board: values.board,
    list: values.list!,
    done: values.done!,
    repo: values.repo ?? process.cwd(),
    dryRun: values["dry-run"],
    json: values.json,
    agent: values.agent,
    limit: values.limit ? parseInt(values.limit, 10) : undefined,
    label: values.label,
    pr: values.pr,
    retry: values.retry,
    webhook: values.webhook,
    testCommand: values["test-command"],
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
} catch (err: any) {
  if (values.json) {
    console.log(JSON.stringify({ error: err.message }));
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
}
