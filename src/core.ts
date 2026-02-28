/**
 * Core autopilot logic: scan bugs, fix via coding agent, move cards.
 */

import { TrelloClient, TrelloCard, TrelloComment } from "./trello.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BugInfo {
  card: TrelloCard;
  comments: TrelloComment[];
}

export interface FixResult {
  cardId: string;
  cardName: string;
  success: boolean;
  summary: string;
  error?: string;
}

export interface AutopilotOpts {
  board: string;
  list: string;
  done: string;
  repo: string;
  dryRun?: boolean;
  json?: boolean;
  agent?: string; // coding agent command, default "claude"
}

export function createClient(): TrelloClient {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!apiKey || !token) {
    throw new Error("Missing TRELLO_API_KEY or TRELLO_TOKEN environment variables");
  }
  return new TrelloClient({ apiKey, token });
}

/** Scan bug cards from a Trello list. */
export async function scanBugs(client: TrelloClient, boardName: string, listName: string): Promise<BugInfo[]> {
  const board = await client.findBoard(boardName);
  if (!board) throw new Error(`Board "${boardName}" not found`);

  const list = await client.findList(board.id, listName);
  if (!list) throw new Error(`List "${listName}" not found on board "${boardName}"`);

  const cards = await client.getCards(list.id);
  const bugs: BugInfo[] = [];
  for (const card of cards) {
    const comments = await client.getComments(card.id);
    bugs.push({ card, comments });
  }
  return bugs;
}

/** Build a prompt for the coding agent from bug info. */
export function buildPrompt(bug: BugInfo): string {
  const parts = [`Fix this bug: ${bug.card.name}`];
  if (bug.card.desc) parts.push(`\nDescription:\n${bug.card.desc}`);
  if (bug.card.labels.length) parts.push(`\nLabels: ${bug.card.labels.map((l) => l.name).join(", ")}`);
  if (bug.comments.length) {
    parts.push(`\nComments:`);
    for (const c of bug.comments) {
      parts.push(`- ${c.memberCreator.fullName}: ${c.data.text}`);
    }
  }
  return parts.join("\n");
}

/** Invoke coding agent to fix a bug. Returns agent output summary. */
export async function invokeAgent(prompt: string, repo: string, agent = "claude"): Promise<string> {
  try {
    const { stdout } = await execFileAsync(agent, ["-p", prompt, "--output-format", "text"], {
      cwd: repo,
      timeout: 300_000, // 5 min
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || "(no output)";
  } catch (err: any) {
    throw new Error(`Agent failed: ${err.message}`);
  }
}

/** Fix a single bug: invoke agent, move card, add comment. */
export async function fixBug(
  client: TrelloClient,
  bug: BugInfo,
  doneListId: string,
  repo: string,
  opts?: { dryRun?: boolean; agent?: string }
): Promise<FixResult> {
  const prompt = buildPrompt(bug);

  if (opts?.dryRun) {
    return {
      cardId: bug.card.id,
      cardName: bug.card.name,
      success: true,
      summary: `[dry-run] Would fix: ${bug.card.name}`,
    };
  }

  try {
    const summary = await invokeAgent(prompt, repo, opts?.agent);
    await client.moveCard(bug.card.id, doneListId);
    await client.addComment(bug.card.id, `🤖 Auto-fixed by trello-autopilot:\n\n${summary}`);
    return { cardId: bug.card.id, cardName: bug.card.name, success: true, summary };
  } catch (err: any) {
    return {
      cardId: bug.card.id,
      cardName: bug.card.name,
      success: false,
      summary: "",
      error: err.message,
    };
  }
}

/** Run the full autopilot pipeline. */
export async function run(opts: AutopilotOpts): Promise<FixResult[]> {
  const client = createClient();

  const board = await client.findBoard(opts.board);
  if (!board) throw new Error(`Board "${opts.board}" not found`);

  const doneList = await client.findList(board.id, opts.done);
  if (!doneList) throw new Error(`Done list "${opts.done}" not found`);

  const bugs = await scanBugs(client, opts.board, opts.list);
  const results: FixResult[] = [];

  for (const bug of bugs) {
    const result = await fixBug(client, bug, doneList.id, opts.repo, {
      dryRun: opts.dryRun,
      agent: opts.agent,
    });
    results.push(result);

    if (!opts.json) {
      const icon = result.success ? "✅" : "❌";
      console.log(`${icon} ${result.cardName}${result.error ? ` — ${result.error}` : ""}`);
    }
  }

  return results;
}
