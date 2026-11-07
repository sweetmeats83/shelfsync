import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollAbs, resetAbsState } from "../src/abs.js";
import { openDb } from "../src/db.js";
import type { HardcoverApi } from "../src/hardcover.js";

function fakeHc(over: Partial<HardcoverApi> = {}): HardcoverApi {
  return {
    me: async () => ({ id: 1, username: "n" }),
    bookById: async (id) => ({ id, title: "T", author: "A", editions: [] }),
    editionById: async () => null,
    editionByIsbn: async () => null,
    editionByAsin: async () => ({ id: 500, bookId: 42, pages: null, audioSeconds: 36000, title: "Project Hail Mary", author: "Andy Weir" }),
    userBook: async () => null,
    search: async () => [],
    ...over,
  };
}

function fakeFetch(me: unknown, item: unknown = { media: { metadata: { title: "Project Hail Mary", authorName: "Andy Weir", asin: "B08G9PRS1K" } } }) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/api/me")) return new Response(JSON.stringify(me), { status: 200 });
    if (u.includes("/api/items/")) return new Response(JSON.stringify(item), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

const base = { url: "http://abs", token: "t", maxAgeDays: 1e9 }; // test timestamps are ancient

describe("backlog guard", () => {
  it("ignores items not updated within the window; takes recent ones", async () => {
    const db = openDb(":memory:");
    const nowSec = 1_800_000_000;
    const me = {
      mediaProgress: [
        { libraryItemId: "old", progress: 1, isFinished: true, lastUpdate: (nowSec - 30 * 86400) * 1000 },
        { libraryItemId: "new", progress: 0.3, lastUpdate: (nowSec - 86400) * 1000 },
      ],
    };
    const r = await pollAbs({ url: "http://abs", token: "t", db, hc: null, fetchFn: fakeFetch(me), now: () => nowSec, maxAgeDays: 7 });
    expect(r.seen).toBe(1);
    expect(db.prepare("SELECT item_id FROM abs_progress").all()).toEqual([{ item_id: "new" }]);
  });
});

describe("pollAbs", () => {
  beforeEach(() => resetAbsState());

  it("stores progress, links by ASIN and notifies once; unchanged polls do nothing", async () => {
    const db = openDb(":memory:");
    const onChange = vi.fn();
    const me = { mediaProgress: [{ libraryItemId: "li1", progress: 0.4, currentTime: 100, duration: 250, isFinished: false, lastUpdate: 1_700_000_000_000 }] };
    const f = fakeFetch(me);
    const r1 = await pollAbs({ ...base, db, hc: fakeHc(), onChange, fetchFn: f });
    expect(r1).toMatchObject({ ok: true, seen: 1, changed: 1 });
    expect(db.prepare("SELECT method FROM links WHERE source='abs' AND source_id='li1'").get()).toEqual({ method: "abs-asin" });
    expect(onChange).toHaveBeenCalledWith("li1");
    const r2 = await pollAbs({ ...base, db, hc: fakeHc(), onChange, fetchFn: f });
    expect(r2.changed).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("links an audiobook through Calibre's Hardcover id when the title and author match", async () => {
    const db = openDb(":memory:");
    const calibre = {
      byTitleAuthor: (t: string) => (t === "The Bright Sword" ? { id: 7, title: t, authors: ["Lev Grossman"], uuid: "u" } : null),
      identifiers: () => ({ "hardcover-id": "484946", hardcover: "the-bright-sword", "hardcover-edition": "31176149" }),
    } as any;
    const item = { media: { metadata: { title: "The Bright Sword", authorName: "Lev Grossman" } } }; // no ISBN/ASIN at all
    const me = { mediaProgress: [{ libraryItemId: "li7", progress: 0.2, duration: 100, lastUpdate: 1_700_000_000_000 }] };
    await pollAbs({ ...base, db, hc: fakeHc(), calibre, fetchFn: fakeFetch(me, item) });
    expect(db.prepare("SELECT b.hardcover_book_id h, l.method m FROM links l JOIN books b ON b.id = l.book_id").get()).toEqual({
      h: 484946,
      m: "calibre-hardcover-id",
    });
  });

  it("skips podcast episodes and untouched (0%) items without calling Hardcover", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    const spy = vi.spyOn(hc, "editionByAsin");
    const me = {
      mediaProgress: [
        { libraryItemId: "p1", episodeId: "e1", progress: 0.5, lastUpdate: 1 },
        { libraryItemId: "z1", progress: 0, isFinished: false, lastUpdate: 2 },
      ],
    };
    const r = await pollAbs({ ...base, db, hc, fetchFn: fakeFetch(me) });
    expect(r.seen).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not retry an unresolved item on every poll", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ editionByAsin: async () => null });
    const f = fakeFetch({ mediaProgress: [{ libraryItemId: "u1", progress: 0.2, lastUpdate: 5 }] });
    await pollAbs({ ...base, db, hc, fetchFn: f });
    const itemCalls = () => (f as any).mock.calls.filter((c: any[]) => String(c[0]).includes("/api/items/")).length;
    expect(itemCalls()).toBe(1);
    await pollAbs({ ...base, db, hc, fetchFn: f });
    expect(itemCalls()).toBe(1);
  });

  it("does not guess by title when ABS gives no author, and reads authors[] when present", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ editionByAsin: async () => null, search: async () => [{ id: 9, title: "Heorot", author: "Jim Butcher", users: 40 }] });
    const spy = vi.spyOn(hc, "search");
    const noAuthor = fakeFetch({ mediaProgress: [{ libraryItemId: "a", progress: 0.5, lastUpdate: 1 }] }, { media: { metadata: { title: "Heorot" } } });
    await pollAbs({ ...base, db, hc, fetchFn: noAuthor });
    expect(spy).not.toHaveBeenCalled();
    const withAuthors = fakeFetch(
      { mediaProgress: [{ libraryItemId: "b", progress: 0.5, lastUpdate: 2 }] },
      { media: { metadata: { title: "Heorot", authors: [{ name: "Jim Butcher" }] } } },
    );
    await pollAbs({ ...base, db, hc, fetchFn: withAuthors });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("backfills names for stored items that have none", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO abs_progress (item_id, progress, is_finished, last_update) VALUES ('old1', 0.4, 0, 1)").run();
    const item = { media: { metadata: { title: "Heorot", authors: [{ name: "Jim Butcher" }] } } };
    await pollAbs({ ...base, db, hc: null, fetchFn: fakeFetch({ mediaProgress: [] }, item) });
    expect(db.prepare("SELECT title, author FROM abs_progress WHERE item_id='old1'").get()).toEqual({ title: "Heorot", author: "Jim Butcher" });
  });

  it("stores ABS start and finish dates", async () => {
    const db = openDb(":memory:");
    const me = { mediaProgress: [{ libraryItemId: "d", progress: 1, isFinished: true, lastUpdate: 5000, startedAt: 1_600_000_000_000, finishedAt: 1_650_000_000_000 }] };
    await pollAbs({ ...base, db, hc: null, fetchFn: fakeFetch(me) });
    expect(db.prepare("SELECT started_at s, finished_at f FROM abs_progress WHERE item_id='d'").get()).toEqual({ s: 1_600_000_000, f: 1_650_000_000 });
  });

  it("reports an HTTP failure without throwing", async () => {
    const db = openDb(":memory:");
    const f = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const r = await pollAbs({ ...base, db, hc: null, fetchFn: f });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain("401");
  });

  it("keeps the ebook edition (with pages) when an audio edition linked the book first", async () => {
    const db = openDb(":memory:");
    const f = fakeFetch({ mediaProgress: [{ libraryItemId: "li1", progress: 0.1, lastUpdate: 9 }] });
    await pollAbs({ ...base, db, hc: fakeHc(), fetchFn: f });
    const { linkSource } = await import("../src/identification.js");
    const hc2 = fakeHc({ editionById: async () => ({ id: 777, bookId: 42, pages: 476, audioSeconds: null, title: "Project Hail Mary", author: "Andy Weir" }) });
    await linkSource({ db, hc: hc2 }, "koreader", "dochash", { hardcover_edition_id: 777 });
    expect(db.prepare("SELECT hardcover_edition_id e, pages p FROM books WHERE hardcover_book_id = 42").get()).toEqual({ e: 777, p: 476 });
  });
});
