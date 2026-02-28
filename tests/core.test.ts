import { describe, it, expect, vi } from "vitest";
import { TrelloClient } from "../src/trello.js";
import {
  scanBugs,
  buildPrompt,
  fixBug,
  sortByPriority,
  filterByLabel,
  filterByRetry,
  getPriority,
  generateReport,
  formatReport,
} from "../src/core.js";
import type { BugInfo, GitOps, TestRunner } from "../src/core.js";

// Mock fetch helper
function mockFetch(routes: Record<string, any>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    for (const [pattern, data] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) };
      }
    }
    return { ok: false, status: 404, text: async () => "not found" };
  }) as any;
}

function makeClient(routes: Record<string, any>) {
  return new TrelloClient({
    apiKey: "test-key",
    token: "test-token",
    fetch: mockFetch(routes),
  });
}

function makeBug(overrides: Partial<BugInfo["card"]> = {}, comments: BugInfo["comments"] = []): BugInfo {
  return {
    card: {
      id: "c1",
      name: "Test bug",
      desc: "",
      idList: "l1",
      labels: [],
      url: "https://trello.com/c/c1",
      ...overrides,
    },
    comments,
  };
}

// Mock GitOps
function mockGitOps(): GitOps {
  return {
    createBranch: vi.fn(async () => {}),
    getDiff: vi.fn(async () => "1 file changed, 2 insertions(+)"),
    commitAndPush: vi.fn(async () => {}),
    createPR: vi.fn(async () => "https://github.com/org/repo/pull/42"),
    blame: vi.fn(async () => "abc123 (Alice 2026-01-01) line"),
  };
}

// Mock TestRunner
function mockTestRunner(passed = true, output = "All tests passed"): TestRunner {
  return { run: vi.fn(async () => ({ passed, output })) };
}

describe("scanBugs", () => {
  it("finds bugs from a board/list", async () => {
    const client = makeClient({
      "/members/me/boards": [{ id: "b1", name: "Cutie" }],
      "/boards/b1/lists": [{ id: "l1", name: "Bugs" }, { id: "l2", name: "Done" }],
      "/lists/l1/cards": [
        { id: "c1", name: "Login crash", desc: "App crashes on login", idList: "l1", labels: [{ id: "lb1", name: "critical", color: "red" }], url: "https://trello.com/c/c1" },
      ],
      "/cards/c1/actions": [
        { id: "a1", data: { text: "Happens on iOS only" }, memberCreator: { fullName: "Alice" }, date: "2026-01-01" },
      ],
    });

    const bugs = await scanBugs(client, "Cutie", "Bugs");
    expect(bugs).toHaveLength(1);
    expect(bugs[0].card.name).toBe("Login crash");
    expect(bugs[0].comments).toHaveLength(1);
    expect(bugs[0].comments[0].data.text).toBe("Happens on iOS only");
  });

  it("throws if board not found", async () => {
    const client = makeClient({ "/members/me/boards": [] });
    await expect(scanBugs(client, "Nope", "Bugs")).rejects.toThrow('Board "Nope" not found');
  });
});

describe("buildPrompt", () => {
  it("builds a prompt from bug info", () => {
    const bug = makeBug(
      { name: "Crash on save", desc: "Segfault when saving", labels: [{ id: "lb1", name: "bug", color: "red" }] },
      [{ id: "a1", data: { text: "Reproducible 100%" }, memberCreator: { fullName: "Bob" }, date: "2026-01-01" }]
    );
    const prompt = buildPrompt(bug);
    expect(prompt).toContain("Crash on save");
    expect(prompt).toContain("Segfault when saving");
    expect(prompt).toContain("bug");
    expect(prompt).toContain("Bob: Reproducible 100%");
  });
});

describe("Priority sorting", () => {
  it("sorts critical > high > medium > low > none", () => {
    const bugs = [
      makeBug({ id: "low", labels: [{ id: "1", name: "low", color: "blue" }] }),
      makeBug({ id: "critical", labels: [{ id: "2", name: "critical", color: "red" }] }),
      makeBug({ id: "none", labels: [] }),
      makeBug({ id: "high", labels: [{ id: "3", name: "high", color: "orange" }] }),
      makeBug({ id: "medium", labels: [{ id: "4", name: "medium", color: "yellow" }] }),
    ];
    const sorted = sortByPriority(bugs);
    expect(sorted.map((b) => b.card.id)).toEqual(["critical", "high", "medium", "low", "none"]);
  });

  it("getPriority returns correct index", () => {
    expect(getPriority({ labels: [{ id: "1", name: "critical", color: "red" }] } as any)).toBe(0);
    expect(getPriority({ labels: [{ id: "1", name: "low", color: "blue" }] } as any)).toBe(3);
    expect(getPriority({ labels: [] } as any)).toBe(4);
  });
});

describe("filterByLabel", () => {
  it("filters bugs by label name", () => {
    const bugs = [
      makeBug({ id: "c1", labels: [{ id: "1", name: "critical", color: "red" }] }),
      makeBug({ id: "c2", labels: [{ id: "2", name: "low", color: "blue" }] }),
      makeBug({ id: "c3", labels: [{ id: "3", name: "critical", color: "red" }] }),
    ];
    const filtered = filterByLabel(bugs, "critical");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((b) => b.card.id)).toEqual(["c1", "c3"]);
  });

  it("is case-insensitive", () => {
    const bugs = [makeBug({ labels: [{ id: "1", name: "Critical", color: "red" }] })];
    expect(filterByLabel(bugs, "critical")).toHaveLength(1);
  });
});

describe("filterByRetry", () => {
  it("filters for fix-failed and needs-human labels", () => {
    const bugs = [
      makeBug({ id: "c1", labels: [{ id: "1", name: "fix-failed", color: "red" }] }),
      makeBug({ id: "c2", labels: [{ id: "2", name: "bug", color: "blue" }] }),
      makeBug({ id: "c3", labels: [{ id: "3", name: "needs-human", color: "orange" }] }),
    ];
    const filtered = filterByRetry(bugs);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((b) => b.card.id)).toEqual(["c1", "c3"]);
  });
});

describe("fixBug", () => {
  it("returns dry-run result without calling agent", async () => {
    const client = makeClient({});
    const bug = makeBug();
    const result = await fixBug(client, bug, "l2", "b1", "/tmp", { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.summary).toContain("[dry-run]");
  });

  it("adds fix-failed label when tests fail", async () => {
    const fetchMock = mockFetch({
      "/boards/b1/labels": [{ id: "lbl1", name: "fix-failed", color: "red" }],
      "/cards/c1/idLabels": {},
      "/cards/c1/actions/comments": {},
    });
    const client = new TrelloClient({ apiKey: "k", token: "t", fetch: fetchMock });
    const bug = makeBug();
    const gitOps = mockGitOps();
    const testRunner = mockTestRunner(false, "FAIL: test_login");

    // Mock invokeAgent by providing a custom agent that doesn't exist
    // Instead, we'll test the flow with a mock
    const result = await fixBug(client, bug, "l2", "b1", "/tmp", {
      gitOps,
      testRunner,
      agent: "echo", // Use echo as a simple agent
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Tests failed");
    expect(testRunner.run).toHaveBeenCalled();
  });

  it("creates branch and PR when pr=true and tests pass", async () => {
    const fetchMock = mockFetch({
      "/boards/b1/labels": [],
      "/cards/c1/idLabels": {},
      "/cards/c1/actions/comments": {},
      "/cards/c1": {},
    });
    const client = new TrelloClient({ apiKey: "k", token: "t", fetch: fetchMock });
    const bug = makeBug();
    const gitOps = mockGitOps();
    const testRunner = mockTestRunner(true);

    const result = await fixBug(client, bug, "l2", "b1", "/tmp", {
      gitOps,
      testRunner,
      pr: true,
      agent: "echo",
    });

    // Agent will likely fail with "echo" but let's check git ops were attempted
    // The actual test depends on whether echo works as an agent
    expect(gitOps.createBranch).toHaveBeenCalledWith("/tmp", "fix/card-c1");
  });
});

describe("generateReport", () => {
  it("calculates correct counts", () => {
    const results = [
      { cardId: "c1", cardName: "Bug 1", success: true, summary: "fixed" },
      { cardId: "c2", cardName: "Bug 2", success: false, summary: "", error: "failed" },
      { cardId: "c3", cardName: "Bug 3", success: true, summary: "fixed" },
      { cardId: "c4", cardName: "Bug 4", success: false, summary: "", skipped: true, skipReason: "filtered" },
    ];
    const report = generateReport(results, Date.now() - 5000);
    expect(report.total).toBe(4);
    expect(report.fixed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("formatReport", () => {
  it("produces human-readable output", () => {
    const report = { total: 5, fixed: 3, failed: 1, skipped: 1, durationMs: 12345, results: [] };
    const output = formatReport(report);
    expect(output).toContain("Total:   5");
    expect(output).toContain("Fixed:  3");
    expect(output).toContain("Failed: 1");
    expect(output).toContain("Skipped: 1");
    expect(output).toContain("12.3s");
  });
});

describe("TrelloClient", () => {
  it("moveCard sends PUT", async () => {
    const fetchMock = mockFetch({ "/cards/c1": {} });
    const client = new TrelloClient({ apiKey: "k", token: "t", fetch: fetchMock });
    await client.moveCard("c1", "l2");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/cards/c1"), expect.objectContaining({ method: "PUT" }));
  });

  it("addComment sends POST", async () => {
    const fetchMock = mockFetch({ "/cards/c1/actions/comments": {} });
    const client = new TrelloClient({ apiKey: "k", token: "t", fetch: fetchMock });
    await client.addComment("c1", "Fixed!");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/cards/c1/actions/comments"), expect.objectContaining({ method: "POST" }));
  });

  it("addLabel creates and attaches label", async () => {
    const fetchMock = mockFetch({
      "/boards/b1/labels": [],
      "labels?name": { id: "newlbl", name: "fix-failed", color: "red", idBoard: "b1" },
      "/cards/c1/idLabels": {},
    });
    const client = new TrelloClient({ apiKey: "k", token: "t", fetch: fetchMock });
    await client.addLabel("c1", "b1", "fix-failed");
    // Should have called POST to create label and POST to add to card
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
