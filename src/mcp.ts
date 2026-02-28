#!/usr/bin/env node
/**
 * MCP Server for trello-autopilot.
 * Tools: scan_bugs, fix_bug, move_card
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, scanBugs, fixBug, buildPrompt } from "./core.js";

const server = new McpServer({
  name: "trello-autopilot",
  version: "0.1.0",
});

server.tool(
  "scan_bugs",
  "Scan a Trello board list for bug cards. Returns card details with comments.",
  {
    board: z.string().describe("Trello board name"),
    list: z.string().default("Bugs").describe("List name to scan"),
  },
  async ({ board, list }) => {
    const client = createClient();
    const bugs = await scanBugs(client, board, list);
    const result = bugs.map((b) => ({
      id: b.card.id,
      name: b.card.name,
      desc: b.card.desc,
      labels: b.card.labels.map((l) => l.name),
      url: b.card.url,
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
  "Fix a bug card by invoking a coding agent, then move it to the Done list and add a comment.",
  {
    board: z.string().describe("Trello board name"),
    list: z.string().default("Bugs").describe("Source list name"),
    done: z.string().default("Done").describe("Destination list name"),
    cardId: z.string().describe("Trello card ID to fix"),
    repo: z.string().describe("Path to the repository"),
    dryRun: z.boolean().default(false).describe("If true, preview only"),
    agent: z.string().default("claude").describe("Coding agent command"),
  },
  async ({ board, list, done, cardId, repo, dryRun, agent }) => {
    const client = createClient();
    const bugs = await scanBugs(client, board, list);
    const bug = bugs.find((b) => b.card.id === cardId);
    if (!bug) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Card ${cardId} not found in list "${list}"` }) }] };
    }

    const boardObj = await client.findBoard(board);
    const doneList = await client.findList(boardObj!.id, done);
    if (!doneList) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Done list "${done}" not found` }) }] };
    }

    const result = await fixBug(client, bug, doneList.id, repo, { dryRun, agent });
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

const transport = new StdioServerTransport();
await server.connect(transport);
