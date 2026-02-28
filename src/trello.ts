/**
 * Trello API client — thin wrapper over REST API.
 */

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  labels: { id: string; name: string; color: string }[];
  url: string;
}

export interface TrelloComment {
  id: string;
  data: { text: string };
  memberCreator: { fullName: string };
  date: string;
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
}

export interface TrelloClientOpts {
  apiKey: string;
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class TrelloClient {
  private apiKey: string;
  private token: string;
  private baseUrl: string;
  private _fetch: typeof globalThis.fetch;

  constructor(opts: TrelloClientOpts) {
    this.apiKey = opts.apiKey;
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.trello.com/1";
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${path}${sep}key=${this.apiKey}&token=${this.token}`;
    const res = await this._fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Trello API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Find board by name (searches member's boards). */
  async findBoard(name: string): Promise<TrelloBoard | undefined> {
    const boards = await this.req<TrelloBoard[]>("/members/me/boards?fields=name");
    return boards.find((b) => b.name.toLowerCase() === name.toLowerCase());
  }

  /** Get lists on a board. */
  async getLists(boardId: string): Promise<TrelloList[]> {
    return this.req<TrelloList[]>(`/boards/${boardId}/lists?fields=name`);
  }

  /** Find a list by name on a board. */
  async findList(boardId: string, name: string): Promise<TrelloList | undefined> {
    const lists = await this.getLists(boardId);
    return lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  }

  /** Get cards on a list. */
  async getCards(listId: string): Promise<TrelloCard[]> {
    return this.req<TrelloCard[]>(`/lists/${listId}/cards?fields=name,desc,idList,labels,url`);
  }

  /** Get comments on a card. */
  async getComments(cardId: string): Promise<TrelloComment[]> {
    return this.req<TrelloComment[]>(
      `/cards/${cardId}/actions?filter=commentCard&fields=data,memberCreator,date`
    );
  }

  /** Move card to a different list. */
  async moveCard(cardId: string, listId: string): Promise<void> {
    await this.req(`/cards/${cardId}?idList=${listId}`, { method: "PUT" });
  }

  /** Add comment to a card. */
  async addComment(cardId: string, text: string): Promise<void> {
    await this.req(`/cards/${cardId}/actions/comments?text=${encodeURIComponent(text)}`, {
      method: "POST",
    });
  }
}
