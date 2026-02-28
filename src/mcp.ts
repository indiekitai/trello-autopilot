#!/usr/bin/env node
/**
 * MCP Server for trello-autopilot.
 * Tools: scan_bugs, fix_bug, move_card, retry_failed, get_report
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createClient,
  scanBugs,
  fixBug,
  sortByPriority,
  filterByLabel,
  filterByRetry,
  generateReport,
} from "./core.js";

const server = new McpServer({
  name: "trello-autopilot",
  version: "0.2.0",
});

server.tool(
  "scan_bugs",
  "Scan a Trello board list for bug cards. Returns card details with comments, sorted by priority.",
  {
    board: z.string().describe("Trello board name"),
    list: z.string().default("Bugs").describe("List name to scan"),
    label: z.string().optional().describe("Filter by label name"),
    limit: z.number().optional().describe("Max number of cards to return"),
  },
  async ({ board, list, label, limit }) => {
    const client = createClient();
    let bugs = await scanBugs(client, board, list);
    bugs = sortByPriority(bugs);
    if (label) bugs = filterByLabel(bugs, label);
    if (limit) bugs = bugs.slice(0, limit);

    const result = bugs.map((b) => ({
      id: b.card.id,
      name: b.card.name,
      desc: b.card.desc,
      labels: b.card.labels.map((l) => l.name),
      url: b.card.url,
      priority: b.card.labels.map((l) => l.name.toLowerCase()).find((n) => ["critical", "high", "medium", "low"].includes(n)) ?? "none",
      comments: b.comments.map((c) => ({
        author: c.memberCreator.fullName,
        text: c.data.text,
        date: c.date,
      })),
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "fix_bug",
  "Fix a bug card: invoke coding agent, run tests, manage git branch/PR, move card on success.",
  {
    board: z.string().describe("Trello board name"),
    list: z.string().default("Bugs").describe("Source list name"),
    done: z.string().default("Done").describe("Destination list name"),
    cardId: z.string().describe("Trello card ID to fix"),
    repo: z.string().describe("Path to the repository"),
    dryRun: z.boolean().default(false).describe("If true, preview only"),
    agent: z.string().default("claude").describe("Coding agent command"),
    pr: z.boolean().default(false).describe("Create PR instead of pushing to main"),
    testCommand: z.string().optional().describe("Custom test command"),
  },
  async ({ board, list, done, cardId, repo, dryRun, agent, pr, testCommand }) => {
    const client = createClient();
    const bugs = await scanBugs(client, board, list);
    const bug = bugs.find((b) => b.card.id === cardId);
    if (!bug) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Card ${cardId} not found in list "${list}"` }) }],
      };
    }

    const boardObj = await client.findBoard(board);
    const doneList = await client.findList(boardObj!.id, done);
    if (!doneList) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Done list "${done}" not found` }) }],
      };
    }

    const result = await fixBug(client, bug, doneList.id, boardObj!.id, repo, { dryRun, agent, pr, testCommand });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "move_card",
  "Move a Trello card to a different list and optionally add a comment.",
  {
    cardId: z.string().describe("Trello card ID"),
    board: z.string().describe("Board name"),
    targetList: z.string().describe("Target list name"),
    comment: z.string().optional().describe("Optional comment to add"),
  },
  async ({ cardId, board, targetList, comment }) => {
    const client = createClient();
    const boardObj = await client.findBoard(board);
    if (!boardObj) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Board "${board}" not found` }) }] };
    }
    const list = await client.findList(boardObj.id, targetList);
    if (!list) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `List "${targetList}" not found` }) }] };
    }
    await client.moveCard(cardId, list.id);
    if (comment) await client.addComment(cardId, comment);
    return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, cardId, movedTo: targetList }) }] };
  }
);

server.tool(
  "retry_failed",
  "Retry previously failed cards (those with fix-failed or needs-human labels).",
  {
    board: z.string().describe("Trello board name"),
    list: z.string().default("Bugs").describe("Source list name"),
    done: z.string().default("Done").describe("Destination list name"),
    repo: z.string().describe("Path to the repository"),
    agent: z.string().default("claude").describe("Coding agent command"),
    pr: z.boolean().default(false).describe("Create PR instead of pushing to main"),
    limit: z.number().optional().describe("Max number of cards to retry"),
  },
  async ({ board, list, done, repo, agent, pr, limit }) => {
    const client = createClient();
    let bugs = await scanBugs(client, board, list);
    bugs = filterByRetry(bugs);
    bugs = sortByPriority(bugs);
    if (limit) bugs = bugs.slice(0, limit);

    const boardObj = await client.findBoard(board);
    const doneList = await client.findList(boardObj!.id, done);
    if (!doneList) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Done list "${done}" not found` }) }] };
    }

    const startTime = Date.now();
    const results = [];
    for (const bug of bugs) {
      const result = await fixBug(client, bug, doneList.id, boardObj!.id, repo, { agent, pr });
      results.push(result);
    }

    const report = generateReport(results, startTime);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  }
);

server.tool(
  "get_report",
  "Run autopilot on a board and return a structured report with counts and timing.",
  {
    board: z.string().describe("Trello board name"),
    list: z.string().default("Bugs").describe("Source list name"),
    done: z.string().default("Done").describe("Destination list name"),
    repo: z.string().describe("Path to the repository"),
    agent: z.string().default("claude").describe("Coding agent command"),
    dryRun: z.boolean().default(true).describe("If true, preview only (default: true)"),
    label: z.string().optional().describe("Filter by label"),
    limit: z.number().optional().describe("Max cards to process"),
  },
  async ({ board, list, done, repo, agent, dryRun, label, limit }) => {
    const client = createClient();
    let bugs = await scanBugs(client, board, list);
    bugs = sortByPriority(bugs);
    if (label) bugs = filterByLabel(bugs, label);
    if (limit) bugs = bugs.slice(0, limit);

    const boardObj = await client.findBoard(board);
    const doneList = await client.findList(boardObj!.id, done);
    if (!doneList) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Done list "${done}" not found` }) }] };
    }

    const startTime = Date.now();
    const results = [];
    for (const bug of bugs) {
      const result = await fixBug(client, bug, doneList.id, boardObj!.id, repo, { dryRun, agent });
      results.push(result);
    }

    const report = generateReport(results, startTime);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
