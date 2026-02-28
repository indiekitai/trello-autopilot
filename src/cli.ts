#!/usr/bin/env node
/**
 * trello-autopilot CLI
 */

import { parseArgs } from "node:util";
import { run } from "./core.js";

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
  },
  strict: true,
});

if (values.help || !values.board) {
  console.log(`
trello-autopilot — Trello bug auto-fix CLI

Usage:
  trello-autopilot --board <name> [options]

Options:
  -b, --board <name>   Trello board name (required)
  -l, --list <name>    Bug list name (default: "Bugs")
  -d, --done <name>    Done list name (default: "Done")
  -r, --repo <path>    Repository path (default: cwd)
  -a, --agent <cmd>    Coding agent command (default: "claude")
      --dry-run        Preview only, don't fix or move cards
      --json           Output results as JSON
  -h, --help           Show this help

Environment:
  TRELLO_API_KEY       Trello API key
  TRELLO_TOKEN         Trello token

Examples:
  npx @indiekitai/trello-autopilot --board "Cutie" --list "Bugs" --done "Done" --repo ./myapp
  npx @indiekitai/trello-autopilot --board "Cutie" --dry-run --json
`);
  process.exit(values.help ? 0 : 1);
}

try {
  const results = await run({
    board: values.board,
    list: values.list!,
    done: values.done!,
    repo: values.repo ?? process.cwd(),
    dryRun: values["dry-run"],
    json: values.json,
    agent: values.agent,
  });

  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\nProcessed ${results.length} card(s): ${results.filter((r) => r.success).length} fixed, ${results.filter((r) => !r.success).length} failed`);
  }
} catch (err: any) {
  if (values.json) {
    console.log(JSON.stringify({ error: err.message }));
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
}
