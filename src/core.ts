/**
 * Core autopilot logic: scan bugs, fix via coding agent, move cards.
 * v0.2.0 — with test verification, git integration, priority sorting, failure handling, and reports.
 */

import { TrelloClient, TrelloCard, TrelloComment } from "./trello.js";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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
  skipped?: boolean;
  skipReason?: string;
  branch?: string;
  diffSummary?: string;
  prUrl?: string;
  testOutput?: string;
  blameInfo?: string;
  durationMs?: number;
}

export interface Report {
  total: number;
  fixed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: FixResult[];
}

export interface AutopilotOpts {
  board: string;
  list: string;
  done: string;
  repo: string;
  dryRun?: boolean;
  json?: boolean;
  agent?: string;
  limit?: number;
  label?: string;
  pr?: boolean;
  retry?: boolean;
  webhook?: string;
  testCommand?: string;
}

/** Priority order for labels (lower index = higher priority). */
const PRIORITY_ORDER = ["critical", "high", "medium", "low"];

export function createClient(): TrelloClient {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!apiKey || !token) {
    throw new Error("Missing TRELLO_API_KEY or TRELLO_TOKEN environment variables");
  }
  return new TrelloClient({ apiKey, token });
}

/** Get priority index for a card (lower = higher priority). */
export function getPriority(card: TrelloCard): number {
  const labelNames = card.labels.map((l) => l.name.toLowerCase());
  for (let i = 0; i < PRIORITY_ORDER.length; i++) {
    if (labelNames.includes(PRIORITY_ORDER[i])) return i;
  }
  return PRIORITY_ORDER.length; // no priority label = lowest
}

/** Sort bugs by label priority (critical > high > medium > low). */
export function sortByPriority(bugs: BugInfo[]): BugInfo[] {
  return [...bugs].sort((a, b) => getPriority(a.card) - getPriority(b.card));
}

/** Filter bugs by label name. */
export function filterByLabel(bugs: BugInfo[], label: string): BugInfo[] {
  return bugs.filter((b) =>
    b.card.labels.some((l) => l.name.toLowerCase() === label.toLowerCase())
  );
}

/** Filter bugs to only those with specific labels (for --retry). */
export function filterByRetry(bugs: BugInfo[]): BugInfo[] {
  return bugs.filter((b) =>
    b.card.labels.some(
      (l) => l.name.toLowerCase() === "fix-failed" || l.name.toLowerCase() === "needs-human"
    )
  );
}

/** Scan bug cards from a Trello list. */
export async function scanBugs(
  client: TrelloClient,
  boardName: string,
  listName: string
): Promise<BugInfo[]> {
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
  if (bug.card.labels.length)
    parts.push(`\nLabels: ${bug.card.labels.map((l) => l.name).join(", ")}`);
  if (bug.comments.length) {
    parts.push(`\nComments:`);
    for (const c of bug.comments) {
      parts.push(`- ${c.memberCreator.fullName}: ${c.data.text}`);
    }
  }
  return parts.join("\n");
}

/** Invoke coding agent to fix a bug. Returns agent output summary. */
export async function invokeAgent(
  prompt: string,
  repo: string,
  agent = "claude"
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(agent, ["-p", prompt, "--output-format", "text"], {
      cwd: repo,
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || "(no output)";
  } catch (err: any) {
    throw new Error(`Agent failed: ${err.message}`);
  }
}

// ── Git Integration ──

export interface GitOps {
  createBranch(repo: string, branchName: string): Promise<void>;
  getDiff(repo: string): Promise<string>;
  commitAndPush(repo: string, message: string, branch: string): Promise<void>;
  createPR(repo: string, branch: string, title: string, body: string): Promise<string>;
  blame(repo: string, filePath: string): Promise<string>;
}

export const defaultGitOps: GitOps = {
  async createBranch(repo, branchName) {
    await execAsync(`git checkout -b ${branchName}`, { cwd: repo });
  },
  async getDiff(repo) {
    const { stdout } = await execAsync("git diff --stat", { cwd: repo });
    return stdout.trim();
  },
  async commitAndPush(repo, message, branch) {
    await execAsync(`git add -A && git commit -m "${message}"`, { cwd: repo });
    await execAsync(`git push -u origin ${branch}`, { cwd: repo });
  },
  async createPR(repo, branch, title, body) {
    const { stdout } = await execAsync(
      `gh pr create --head ${branch} --title "${title}" --body "${body}"`,
      { cwd: repo }
    );
    return stdout.trim();
  },
  async blame(repo, filePath) {
    const { stdout } = await execAsync(`git blame --porcelain ${filePath} | head -50`, {
      cwd: repo,
    });
    return stdout.trim();
  },
};

// ── Test Runner ──

export interface TestRunner {
  run(repo: string, command?: string): Promise<{ passed: boolean; output: string }>;
}

/** Detect and run tests in a repo. */
export const defaultTestRunner: TestRunner = {
  async run(repo, command?) {
    let cmd = command;
    if (!cmd) {
      // Auto-detect
      if (existsSync(join(repo, "package.json"))) {
        cmd = "npm test";
      } else if (
        existsSync(join(repo, "pytest.ini")) ||
        existsSync(join(repo, "setup.py")) ||
        existsSync(join(repo, "pyproject.toml"))
      ) {
        cmd = "pytest";
      } else {
        return { passed: true, output: "(no test framework detected, skipping)" };
      }
    }
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: repo, timeout: 120_000 });
      return { passed: true, output: (stdout + "\n" + stderr).trim() };
    } catch (err: any) {
      return { passed: false, output: (err.stdout || "") + "\n" + (err.stderr || err.message) };
    }
  },
};

// ── Webhook ──

async function sendWebhook(url: string, payload: Report): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best effort
  }
}

// ── Fix a single bug ──

export async function fixBug(
  client: TrelloClient,
  bug: BugInfo,
  doneListId: string,
  boardId: string,
  repo: string,
  opts?: {
    dryRun?: boolean;
    agent?: string;
    pr?: boolean;
    gitOps?: GitOps;
    testRunner?: TestRunner;
    testCommand?: string;
  }
): Promise<FixResult> {
  const startTime = Date.now();
  const prompt = buildPrompt(bug);
  const gitOps = opts?.gitOps ?? defaultGitOps;
  const testRunner = opts?.testRunner ?? defaultTestRunner;

  if (opts?.dryRun) {
    return {
      cardId: bug.card.id,
      cardName: bug.card.name,
      success: true,
      summary: `[dry-run] Would fix: ${bug.card.name}`,
      durationMs: Date.now() - startTime,
    };
  }

  const branchName = `fix/card-${bug.card.id}`;
  let branch: string | undefined;
  let diffSummary: string | undefined;
  let prUrl: string | undefined;
  let testOutput: string | undefined;
  let blameInfo: string | undefined;

  try {
    // 1. Create git branch
    try {
      await gitOps.createBranch(repo, branchName);
      branch = branchName;
    } catch {
      // May fail if branch exists or not a git repo — continue anyway
    }

    // 2. Try git blame analysis
    try {
      blameInfo = await gitOps.blame(repo, ".");
    } catch {
      // Not critical
    }

    // 3. Invoke coding agent
    const summary = await invokeAgent(prompt, repo, opts?.agent);

    // 4. Get git diff
    try {
      diffSummary = await gitOps.getDiff(repo);
    } catch {
      // Not a git repo or no changes
    }

    // 5. Run tests
    const testResult = await testRunner.run(repo, opts?.testCommand);
    testOutput = testResult.output;

    if (!testResult.passed) {
      // Test failed — add label and comment, don't move card
      await client.addLabel(bug.card.id, boardId, "fix-failed");
      await client.addComment(
        bug.card.id,
        `🤖 Auto-fix attempted but tests failed:\n\n\`\`\`\n${testResult.output.slice(0, 2000)}\n\`\`\`\n\nAgent output:\n${summary.slice(0, 1000)}`
      );
      return {
        cardId: bug.card.id,
        cardName: bug.card.name,
        success: false,
        summary,
        error: "Tests failed after fix",
        testOutput,
        branch,
        diffSummary,
        blameInfo,
        durationMs: Date.now() - startTime,
      };
    }

    // 6. Commit, push, optionally create PR
    if (branch) {
      try {
        await gitOps.commitAndPush(repo, `fix: ${bug.card.name} (card ${bug.card.id})`, branchName);
        if (opts?.pr) {
          prUrl = await gitOps.createPR(
            repo,
            branchName,
            `fix: ${bug.card.name}`,
            `Auto-fix for Trello card: ${bug.card.url}\n\n${summary.slice(0, 2000)}`
          );
        }
      } catch {
        // Git push/PR may fail — still count as success if tests passed
      }
    }

    // 7. Remove failure labels if present (for --retry)
    try {
      await client.removeLabel(bug.card.id, boardId, "fix-failed");
      await client.removeLabel(bug.card.id, boardId, "needs-human");
    } catch {
      // Best effort
    }

    // 8. Move card and add comment
    await client.moveCard(bug.card.id, doneListId);
    const commentParts = [`🤖 Auto-fixed by trello-autopilot:\n\n${summary}`];
    if (diffSummary) commentParts.push(`\n📊 Changes:\n\`\`\`\n${diffSummary}\n\`\`\``);
    if (prUrl) commentParts.push(`\n🔗 PR: ${prUrl}`);
    await client.addComment(bug.card.id, commentParts.join("\n"));

    return {
      cardId: bug.card.id,
      cardName: bug.card.name,
      success: true,
      summary,
      branch,
      diffSummary,
      prUrl,
      testOutput,
      blameInfo,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    // Fix failed — add needs-human label and detailed comment
    try {
      await client.addLabel(bug.card.id, boardId, "needs-human");
      await client.addComment(
        bug.card.id,
        `🤖 Auto-fix failed:\n\n**Error:** ${err.message}\n\n**Attempted:** Invoked coding agent with prompt based on card description and comments.\n\n**Suggestion:** Review the error above and fix manually. Check if the issue is environmental or requires architectural changes.`
      );
    } catch {
      // Best effort
    }

    return {
      cardId: bug.card.id,
      cardName: bug.card.name,
      success: false,
      summary: "",
      error: err.message,
      branch,
      diffSummary,
      blameInfo,
      durationMs: Date.now() - startTime,
    };
  }
}

/** Generate a report from results. */
export function generateReport(results: FixResult[], startTime: number): Report {
  return {
    total: results.length,
    fixed: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    durationMs: Date.now() - startTime,
    results,
  };
}

/** Format report for human-readable output. */
export function formatReport(report: Report): string {
  const lines = [
    `\n${"═".repeat(50)}`,
    `  📋 Trello Autopilot Report`,
    `${"═".repeat(50)}`,
    `  Total:   ${report.total}`,
    `  ✅ Fixed:  ${report.fixed}`,
    `  ❌ Failed: ${report.failed}`,
    `  ⏭️  Skipped: ${report.skipped}`,
    `  ⏱️  Duration: ${(report.durationMs / 1000).toFixed(1)}s`,
    `${"═".repeat(50)}`,
  ];
  return lines.join("\n");
}

/** Run the full autopilot pipeline. */
export async function run(opts: AutopilotOpts): Promise<Report> {
  const startTime = Date.now();
  const client = createClient();

  const board = await client.findBoard(opts.board);
  if (!board) throw new Error(`Board "${opts.board}" not found`);

  const doneList = await client.findList(board.id, opts.done);
  if (!doneList) throw new Error(`Done list "${opts.done}" not found`);

  let bugs = await scanBugs(client, opts.board, opts.list);

  // Filter by retry (only cards with fix-failed or needs-human labels)
  if (opts.retry) {
    bugs = filterByRetry(bugs);
  }

  // Filter by label
  if (opts.label) {
    bugs = filterByLabel(bugs, opts.label);
  }

  // Sort by priority
  bugs = sortByPriority(bugs);

  // Apply limit
  if (opts.limit && opts.limit > 0) {
    bugs = bugs.slice(0, opts.limit);
  }

  const results: FixResult[] = [];

  for (const bug of bugs) {
    const result = await fixBug(client, bug, doneList.id, board.id, opts.repo, {
      dryRun: opts.dryRun,
      agent: opts.agent,
      pr: opts.pr,
      testCommand: opts.testCommand,
    });
    results.push(result);

    if (!opts.json) {
      const icon = result.success ? "✅" : "❌";
      const extra = result.error ? ` — ${result.error}` : "";
      const prInfo = result.prUrl ? ` (PR: ${result.prUrl})` : "";
      console.log(`${icon} ${result.cardName}${extra}${prInfo}`);
    }
  }

  const report = generateReport(results, startTime);

  // Send webhook if configured
  if (opts.webhook) {
    await sendWebhook(opts.webhook, report);
  }

  return report;
}
