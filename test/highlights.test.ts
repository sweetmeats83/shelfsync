import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { adminApi } from "../src/admin.js";
import { openDb } from "../src/db.js";
import { highlightRoutes } from "../src/highlights.js";
import { kosyncRoutes } from "../src/kosync.js";

const KEY = "5f4dcc3b5aa765d61d8327deb882cf99";
const dev = { "x-auth-user": "nick", "x-auth-key": KEY, "content-type": "application/json" };
const admin = { Authorization: "Basic " + Buffer.from("a:secret").toString("base64"), "content-type": "application/json" };

async function setup() {
  const db = openDb(":memory:");
  const app = new Hono().route("/", kosyncRoutes({ db, registrationDisabled: false })).route("/", highlightRoutes({ db }));
  await app.request("/users/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "nick", password: KEY }) });
  const adm = adminApi({ db, password: "secret", hardcover: null, dryRun: true, absConfigured: false, getHcUser: () => null, notify: vi.fn() });
  const send = (body: object, headers: Record<string, string> = dev) =>
    app.request("/api/highlights", { method: "PUT", headers, body: JSON.stringify(body) });
  return { db, app, adm, send };
}

const H = (text: string, extra: object = {}) => ({ text, datetime: "2026-11-03 20:15:00", chapter: "Ch 1", page: 50, ...extra });

describe("highlights", () => {
  it("requires device auth", async () => {
    const { send } = await setup();
    const r = await send({ document: "d", highlights: [H("x")] }, { "content-type": "application/json" });
    expect(r.status).toBe(401);
  });

  it("stores highlights idempotently and updates device notes without touching ShelfSync notes", async () => {
    const { send, adm, db } = await setup();
    const first = await (await send({ document: "doc1", page_total: 200, highlights: [H("Last night I dreamt"), H("Another line", { datetime: "2026-11-03 20:20:00" })] })).json();
    expect(first).toMatchObject({ stored: 2, added: 2 });
    const again = await (await send({ document: "doc1", page_total: 200, highlights: [H("Last night I dreamt")] })).json();
    expect(again.added).toBe(0);

    const list = (await (await adm.request("/highlights", { headers: admin })).json()) as any[];
    expect(list).toHaveLength(2);
    const id = list.find((h) => h.text === "Last night I dreamt").id;
    expect(list.find((h) => h.id === id)).toMatchObject({ pct: 0.25, chapter: "Ch 1" });

    // my note survives a resend that changes the device note
    await adm.request(`/highlights/${id}/note`, { method: "PUT", headers: admin, body: JSON.stringify({ note: "  love this  " }) });
    await send({ document: "doc1", highlights: [H("Last night I dreamt", { note: "device note" })] });
    const row = db.prepare("SELECT note, my_note FROM highlights WHERE id = ?").get(id);
    expect(row).toEqual({ note: "device note", my_note: "love this" });
  });

  it("prefers the plugin's percentage and keeps the text position", async () => {
    const { send, adm } = await setup();
    await send({ document: "d", page_total: 100, highlights: [H("Located", { page: 10, pct: 0.333, xpointer: "/body/DocFragment[3]/body/p[2]/text().5" })] });
    const [row] = (await (await adm.request("/highlights", { headers: admin })).json()) as any[];
    expect(row.pct).toBeCloseTo(0.333);
  });

  it("ties highlights to a linked book, filters by search, and toggles privacy", async () => {
    const { send, adm, db } = await setup();
    db.prepare("INSERT INTO books (hardcover_book_id, title, author) VALUES (9, 'Rebecca', 'Daphne du Maurier')").run();
    db.prepare("INSERT INTO links VALUES ('koreader','doc1',1,'manual',0)").run();
    await send({ document: "doc1", highlights: [H("Manderley again")] });
    await send({ document: "doc2", highlights: [H("Unrelated thing")] });
    const rebecca = (await (await adm.request("/highlights?q=manderley", { headers: admin })).json()) as any[];
    expect(rebecca).toHaveLength(1);
    expect(rebecca[0]).toMatchObject({ title: "Rebecca", bookId: 1, hcPrivate: true });
    const byBook = (await (await adm.request("/highlights?bookId=1", { headers: admin })).json()) as any[];
    expect(byBook).toHaveLength(1);

    const id = rebecca[0].id;
    expect((await adm.request(`/highlights/${id}/privacy`, { method: "PUT", headers: admin, body: JSON.stringify({ private: false }) })).status).toBe(200);
    const after = (await (await adm.request("/highlights?q=manderley", { headers: admin })).json()) as any[];
    expect(after[0].hcPrivate).toBe(false);
    expect((await adm.request("/highlights/999/note", { method: "PUT", headers: admin, body: JSON.stringify({ note: "x" }) })).status).toBe(404);
    expect((await adm.request(`/highlights/${id}/privacy`, { method: "PUT", headers: admin, body: "{}" })).status).toBe(400);
  });

  it("accepts CrossPoint clippings: probe, upload (idempotent), and delete", async () => {
    const { app, db } = await setup();
    const url = "/api/v1/clippings/doc1";
    expect((await app.request(url + "?cursor=0&limit=1&format=reader")).status).toBe(401);
    const probe = await app.request(url + "?cursor=0&limit=1&format=reader", { headers: dev });
    expect(await probe.json()).toEqual({ sync_version: 2, cursor: 0, more: false, items: [] });

    const put = (items: object[]) => app.request(url, { method: "PUT", headers: dev, body: JSON.stringify({ items }) });
    const item = { id: "a1", spine: 2, start_page: 3, chapter: "Chapter 3", text: "Quoted text", created_at: 1767000000000 };
    const r = await put([item]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accepted: 1 });
    await put([item]);
    const rows = db.prepare("SELECT text, chapter, hl_ts, page, pct FROM highlights").all();
    expect(rows).toEqual([{ text: "Quoted text", chapter: "Chapter 3", hl_ts: 1767000000, page: null, pct: null }]);

    await put([{ id: "a1", deleted: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM highlights").get()).toEqual({ n: 0 });
  });

  it("treats a null pct as unknown rather than 0%", async () => {
    const { send, db } = await setup();
    await send({ document: "d", page_total: 100, highlights: [H("one", { pct: null, page: 50 })] });
    expect(db.prepare("SELECT pct FROM highlights").get()).toEqual({ pct: 0.5 });
  });
});
