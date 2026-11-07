import { describe, expect, it, vi } from "vitest";
import { adminApi } from "../src/admin.js";
import { openDb } from "../src/db.js";
import type { HardcoverApi } from "../src/hardcover.js";

const auth = { Authorization: "Basic " + Buffer.from("me:secret").toString("base64") };

function setup() {
  const db = openDb(":memory:");
  const hc = {
    me: async () => ({ id: 1, username: "n" }),
    bookById: async (id: number) => ({ id, title: "Heorot", author: "Jim Butcher", editions: [{ id: 5, pages: 41 }] }),
    editionById: async () => null,
    editionByIsbn: async () => null,
    editionByAsin: async () => null,
    userBook: async () => null,
    search: async () => [{ id: 836897, title: "Heorot", author: "Jim Butcher", users: 42 }],
  } as unknown as HardcoverApi;
  const notify = vi.fn();
  const app = adminApi({ db, password: "secret", hardcover: hc, dryRun: true, absConfigured: true, getHcUser: () => "n", notify });
  return { db, app, notify };
}

describe("admin api", () => {
  it("requires the password", async () => {
    const { app } = setup();
    expect((await app.request("/status")).status).toBe(401);
    expect((await app.request("/status", { headers: { Authorization: "Basic " + Buffer.from("me:nope").toString("base64") } })).status).toBe(401);
    expect((await app.request("/status", { headers: auth })).status).toBe(200);
  });

  it("lists unmatched items, links one manually, and notifies the engine", async () => {
    const { db, app, notify } = setup();
    db.prepare("INSERT INTO documents (document, title, authors, first_seen, last_seen) VALUES ('h1','Heorot','Jim Butcher',1,2)").run();
    const un = (await (await app.request("/unmatched", { headers: auth })).json()) as any[];
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ source: "koreader", sourceId: "h1", title: "Heorot" });

    const res = await app.request("/link", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ source: "koreader", sourceId: "h1", hardcoverBookId: 836897 }),
    });
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledWith("koreader", "h1");
    expect(((await (await app.request("/unmatched", { headers: auth })).json()) as any[]).length).toBe(0);
    const books = (await (await app.request("/books", { headers: auth })).json()) as any[];
    expect(books[0]).toMatchObject({ title: "Heorot", links: [{ source: "koreader", method: "manual" }] });
  });

  it("manually links an Audiobookshelf item too", async () => {
    const { db, app, notify } = setup();
    db.prepare("INSERT INTO abs_progress (item_id, progress, is_finished, last_update, title) VALUES ('li9', 0.3, 0, 1, 'Heorot')").run();
    const res = await app.request("/link", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ source: "abs", sourceId: "li9", hardcoverBookId: 836897 }),
    });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT method FROM links WHERE source='abs' AND source_id='li9'").get()).toEqual({ method: "manual" });
    expect(notify).toHaveBeenCalledWith("abs", "li9");
  });

  it("unlink returns the item to unmatched and stops auto-guessing it; ignore hides it", async () => {
    const { db, app } = setup();
    db.prepare("INSERT INTO documents (document, title, first_seen, last_seen) VALUES ('h1','Heorot',1,2)").run();
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/link", { source: "koreader", sourceId: "h1", hardcoverBookId: 836897 });
    await post("/unlink", { source: "koreader", sourceId: "h1" });
    expect(db.prepare("SELECT 1 FROM no_auto WHERE source_id='h1'").get()).toBeTruthy();
    expect(((await (await app.request("/unmatched", { headers: auth })).json()) as any[]).length).toBe(1);
    await post("/ignore", { source: "koreader", sourceId: "h1" });
    expect(((await (await app.request("/unmatched", { headers: auth })).json()) as any[]).length).toBe(0);
  });

  it("fills book covers lazily without blocking the response", async () => {
    const { db } = setup();
    const cover = vi.fn(async () => ({ cover: "https://img/x.jpg", slug: "heorot" }));
    const app = adminApi({ db, password: "secret", hardcover: null, dryRun: true, absConfigured: false, getHcUser: () => null, notify: vi.fn(), display: cover });
    db.prepare("INSERT INTO books (hardcover_book_id, title) VALUES (7, 'Heorot')").run();
    const first = (await (await app.request("/books", { headers: auth })).json()) as any[];
    expect(first[0].coverUrl).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(cover).toHaveBeenCalledWith(7);
    const second = (await (await app.request("/books", { headers: auth })).json()) as any[];
    expect(second[0]).toMatchObject({ coverUrl: "https://img/x.jpg", slug: "heorot" });
    expect(cover).toHaveBeenCalledTimes(1);
  });

  it("renames devices and uses the name in the books list", async () => {
    const { db, app } = setup();
    db.prepare("INSERT INTO books (hardcover_book_id, title) VALUES (1, 'Rebecca')").run();
    db.prepare("INSERT INTO links VALUES ('koreader','doc1',1,'manual',0)").run();
    db.prepare("INSERT INTO progress (user_id, document, device, device_id, percentage, updated_at) VALUES (1,'doc1','Kobo Libra','dev-a',0.4,100)").run();
    const put = (id: string, name: unknown) =>
      app.request(`/devices/${id}/name`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const list = async () => (await (await app.request("/devices", { headers: auth })).json()) as any[];
    expect((await list())[0]).toMatchObject({ id: "dev-a", model: "Kobo Libra", name: null, books: 1 });
    expect((await put("dev-a", "  Living-room Kobo ")).status).toBe(200);
    expect((await list())[0].name).toBe("Living-room Kobo");
    const books = (await (await app.request("/books", { headers: auth })).json()) as any[];
    expect(books[0].sources[0].label).toBe("Living-room Kobo");
    expect((await put("dev-a", "")).status).toBe(200); // clearing restores the model name
    expect((await list())[0].name).toBeNull();
    expect((await put("nope", "x")).status).toBe(404);
    expect((await put("dev-a", 5)).status).toBe(400);
  });

  it("sends a picked highlight to Hardcover as a journal entry, private by default, once", async () => {
    const { db } = setup();
    const send = vi.fn(async () => ({ dryRun: false as const, id: 99 }));
    const app = adminApi({ db, password: "secret", hardcover: null, dryRun: false, absConfigured: false, getHcUser: () => null, notify: vi.fn(), sendJournal: send });
    db.prepare("INSERT INTO books (hardcover_book_id, title) VALUES (7, 'Rebecca')").run();
    db.prepare("INSERT INTO links VALUES ('koreader','doc1',1,'manual',0)").run();
    db.prepare("INSERT INTO highlights (key, document, text, my_note, chapter, page, pct, created_at) VALUES ('k','doc1','Last night I dreamt','so good','Ch 1',4,0.05,1)").run();
    const post = () => app.request("/highlights/1/send", { method: "POST", headers: auth });
    const r = await post();
    expect(r.status).toBe(200);
    expect(send).toHaveBeenCalledWith(7, "“Last night I dreamt”\n— Ch 1, p. 4, 5%\n\nso good", 3);
    expect(db.prepare("SELECT hc_journal_id AS j FROM highlights WHERE id=1").get()).toEqual({ j: 99 });
    expect((await post()).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("dry-run journal sends are not marked as sent", async () => {
    const { db } = setup();
    const app = adminApi({ db, password: "secret", hardcover: null, dryRun: true, absConfigured: false, getHcUser: () => null, notify: vi.fn(), sendJournal: async () => ({ dryRun: true as const }) });
    db.prepare("INSERT INTO books (hardcover_book_id, title) VALUES (7, 'Rebecca')").run();
    db.prepare("INSERT INTO links VALUES ('koreader','doc1',1,'manual',0)").run();
    db.prepare("INSERT INTO highlights (key, document, text, created_at) VALUES ('k','doc1','x',1)").run();
    const r = await app.request("/highlights/1/send", { method: "POST", headers: auth });
    expect(((await r.json()) as any).dryRun).toBe(true);
    expect(db.prepare("SELECT hc_journal_id AS j FROM highlights WHERE id=1").get()).toEqual({ j: null });
  });

  it("validates input and filters the activity log", async () => {
    const { db, app } = setup();
    const bad = await app.request("/link", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    db.prepare("INSERT INTO activity (ts, level, source, message) VALUES (1,'error','abs','x'),(2,'info','engine','y')").run();
    const rows = (await (await app.request("/activity?level=error", { headers: auth })).json()) as any[];
    expect(rows.map((r) => r.message)).toEqual(["x"]);
  });

  it("keeps the old link when a manual re-link can't be resolved", async () => {
    const { db } = setup();
    const hc = {
      me: async () => ({ id: 1, username: "n" }),
      bookById: async (id: number) => (id === 836897 ? { id, title: "Heorot", author: "Jim Butcher", editions: [{ id: 5, pages: 41 }] } : null),
      editionById: async () => null,
      editionByIsbn: async () => null,
      editionByAsin: async () => null,
      userBook: async () => null,
      search: async () => [],
    } as unknown as HardcoverApi;
    const app = adminApi({ db, password: "secret", hardcover: hc, dryRun: true, absConfigured: false, getHcUser: () => null, notify: vi.fn() });
    db.prepare("INSERT INTO documents (document, title, first_seen, last_seen) VALUES ('h1','Heorot',1,2)").run();
    const post = (id: number) =>
      app.request("/link", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ source: "koreader", sourceId: "h1", hardcoverBookId: id }) });
    expect((await post(836897)).status).toBe(200);
    expect((await post(1)).status).not.toBe(200); // Hardcover has no such book
    expect(db.prepare("SELECT b.hardcover_book_id AS h FROM links l JOIN books b ON b.id = l.book_id WHERE l.source_id = 'h1'").get()).toEqual({ h: 836897 });
  });

  it("refuses a second send of the same highlight while the first is still in flight", async () => {
    const { db } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn(async () => (await gate, { dryRun: false as const, id: 5 }));
    const app = adminApi({ db, password: "secret", hardcover: null, dryRun: false, absConfigured: false, getHcUser: () => null, notify: vi.fn(), sendJournal: send });
    db.prepare("INSERT INTO books (hardcover_book_id, title) VALUES (7, 'R')").run();
    db.prepare("INSERT INTO links VALUES ('koreader','doc1',1,'manual',0)").run();
    db.prepare("INSERT INTO highlights (key, document, text, created_at) VALUES ('k','doc1','x',1)").run();
    const first = app.request("/highlights/1/send", { method: "POST", headers: auth });
    await new Promise((r) => setTimeout(r, 10));
    expect((await app.request("/highlights/1/send", { method: "POST", headers: auth })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
