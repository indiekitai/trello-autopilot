import { describe, it, expect, vi } from "vitest";
import { TrelloClient } from "../src/trello.js";
import { scanBugs, buildPrompt, fixBug } from "../src/core.js";
import type { BugInfo } from "../src/core.js";

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
    const bug: BugInfo = {
      card: { id: "c1", name: "Crash on save", desc: "Segfault when saving", idList: "l1", labels: [{ id: "lb1", name: "bug", color: "red" }], url: "" },
      comments: [{ id: "a1", data: { text: "Reproducible 100%" }, memberCreator: { fullName: "Bob" }, date: "2026-01-01" }],
    };
    const prompt = buildPrompt(bug);
    expect(prompt).toContain("Crash on save");
    expect(prompt).toContain("Segfault when saving");
    expect(prompt).toContain("bug");
    expect(prompt).toContain("Bob: Reproducible 100%");
  });
});

describe("fixBug (dry-run)", () => {
  it("returns dry-run result without calling agent", async () => {
    const client = makeClient({});
    const bug: BugInfo = {
      card: { id: "c1", name: "Test bug", desc: "", idList: "l1", labels: [], url: "" },
      comments: [],
    };
    const result = await fixBug(client, bug, "l2", "/tmp", { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.summary).toContain("[dry-run]");
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
});
