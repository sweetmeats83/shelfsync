import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { HardcoverClient, parseBookRef, type HardcoverApi } from "../src/hardcover.js";
import { linkSource, manualLink, toIsbn13 } from "../src/identification.js";
import { pickBest } from "../src/matching.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("HardcoverClient", () => {
  it("strips Bearer, sends the token, and unwraps me[]", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ data: { me: [{ id: 7, username: "nick" }] } }));
    const c = new HardcoverClient({ token: "Bearer abc", fetchFn, minIntervalMs: 0, sleep: async () => {} });
    expect(await c.me()).toEqual({ id: 7, username: "nick" });
    expect(fetchFn.mock.calls[0]![1].headers.authorization).toBe("Bearer abc");
  });

  it("backs off and retries on 429", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "3" }))
      .mockResolvedValueOnce(json({ data: { me: { id: 1, username: "x" } } }));
    const c = new HardcoverClient({ token: "t", fetchFn, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect((await c.me()).id).toBe(1);
    expect(sleeps).toContain(3000);
  });

  it("surfaces auth failures and GraphQL errors", async () => {
    const mk = (r: Response) =>
      new HardcoverClient({ token: "t", fetchFn: vi.fn().mockResolvedValue(r), minIntervalMs: 0, sleep: async () => {} });
    await expect(mk(json({}, 401)).me()).rejects.toThrow(/rejected the token/);
    await expect(mk(json({ errors: [{ message: "field not found" }] })).me()).rejects.toThrow(/field not found/);
  });
});

describe("pickBest", () => {
  const hit = (id: number, title: string, author: string | null, users: number | null = null) => ({ id, title, author, users });

  it("handles subtitles and prefers the more-read edition on ties", () => {
    const p = pickBest(
      { title: "Mistborn: The Final Empire", authors: ["Brandon Sanderson"] },
      [hit(1, "Mistborn", "Brandon Sanderson", 10), hit(2, "Mistborn: The Final Empire", "Brandon Sanderson", 5)],
    );
    expect(p?.hit.id).toBe(2); // exact title beats the bare main title
    expect(p?.runnersUp.map((r) => r.id)).toEqual([1]);
  });

  it("accepts any title-similar hit when the author is unknown, rejects poor titles", () => {
    expect(pickBest({ title: "Dune", authors: [] }, [hit(9, "Dune", "Frank Herbert", 1)])?.hit.id).toBe(9);
    expect(pickBest({ title: "Dune", authors: [] }, [hit(9, "The Great Gatsby", "F. Scott Fitzgerald")])).toBeNull();
  });
});

describe("parseBookRef", () => {
  it("accepts id, URL, or slug", () => {
    expect(parseBookRef("12345")).toEqual({ id: 12345 });
    expect(parseBookRef("https://hardcover.app/books/rebecca")).toEqual({ slug: "rebecca" });
    expect(parseBookRef("https://hardcover.app/books/rebecca/editions?x=1")).toEqual({ slug: "rebecca" });
    expect(parseBookRef("rebecca-2")).toEqual({ slug: "rebecca-2" });
    expect(parseBookRef("not a ref!")).toBeNull();
  });
});

describe("toIsbn13", () => {
  it("converts ISBN-10 and strips hyphens", () => {
    expect(toIsbn13("0-306-40615-2")).toBe("9780306406157");
    expect(toIsbn13("978-0-593-13520-4")).toBe("9780593135204");
    expect(toIsbn13("not an isbn")).toBeNull();
  });
});

function fakeHc(over: Partial<HardcoverApi> = {}): HardcoverApi {
  const edition = { id: 900, bookId: 12345, pages: 476, audioSeconds: null, title: "Project Hail Mary", author: "Andy Weir" };
  return {
    me: async () => ({ id: 1, username: "nick" }),
    bookById: async (id) => ({ id, title: "Project Hail Mary", author: "Andy Weir", editions: [{ id: 901, pages: 480 }] }),
    editionById: async () => edition,
    editionByIsbn: async () => edition,
    editionByAsin: async () => ({ ...edition, id: 902, pages: null, audioSeconds: 58000 }),
    userBook: async () => null,
    search: async () => [],
    ...over,
  };
}

describe("linkSource", () => {
  it("links by Hardcover edition id first, then is idempotent", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    const spy = vi.spyOn(hc, "editionById");
    const r = await linkSource({ db, hc }, "koreader", "doc1", { hardcover_edition_id: 900, hardcover_book_id: 1, isbn: "9780593135204" });
    expect(r).toMatchObject({ status: "linked", hardcoverBookId: 12345, method: "calibre-hardcover-id", locked: false });
    expect(r.message).toBe("Linked: Project Hail Mary (Hardcover #12345)");
    await linkSource({ db, hc }, "koreader", "doc1", {});
    expect(spy).toHaveBeenCalledTimes(1); // second call used the stored link
    expect(db.prepare("SELECT count(*) n FROM links").get()).toEqual({ n: 1 });
  });

  it("falls back to book id, then ISBN", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ editionById: async () => null });
    const byBook = await linkSource({ db, hc }, "koreader", "a", { hardcover_edition_id: 1, hardcover_book_id: 5 });
    expect(byBook.method).toBe("calibre-hardcover-id");
    const byIsbn = await linkSource({ db, hc }, "koreader", "b", { isbn: "0306406152" });
    expect(byIsbn.method).toBe("calibre-isbn");
  });

  it("is unresolved with no usable hints (never fuzzy-searches)", async () => {
    const db = openDb(":memory:");
    const r = await linkSource({ db, hc: fakeHc() }, "koreader", "x", {});
    expect(r.status).toBe("unresolved");
    expect(db.prepare("SELECT count(*) n FROM links").get()).toEqual({ n: 0 });
  });

  it("locks a book already marked Read on Hardcover", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ userBook: async () => ({ id: 5, statusId: 3, edition: null }) });
    const r = await linkSource({ db, hc }, "koreader", "d", { isbn: "9780593135204" });
    expect(r.locked).toBe(true);
    expect(db.prepare("SELECT locked_finished l FROM books").get()).toEqual({ l: 1 });
  });

  it("keeps the edition already on the user's shelf", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ userBook: async () => ({ id: 5, statusId: 2, edition: { id: 555, pages: 300 } }) });
    await linkSource({ db, hc }, "koreader", "d", { isbn: "9780593135204" });
    expect(db.prepare("SELECT hardcover_edition_id e, pages p FROM books").get()).toEqual({ e: 555, p: 300 });
  });

  it("ABS: isbn then asin, and audio edition keeps audio_seconds", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ editionByIsbn: async () => null });
    const r = await linkSource({ db, hc }, "abs", "item1", { isbn: "9780593135204", asin: "B08G9PRS1K" });
    expect(r.method).toBe("abs-asin");
    expect(db.prepare("SELECT audio_seconds a FROM books").get()).toEqual({ a: 58000 });
  });

  it("manualLink overrides an automatic link and records method=manual", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    await linkSource({ db, hc }, "koreader", "d", { isbn: "9780593135204" });
    const r = await manualLink({ db, hc }, "koreader", "d", 777);
    expect(r).toMatchObject({ status: "linked", method: "manual", hardcoverBookId: 777 });
    expect(db.prepare("SELECT method m FROM links WHERE source_id='d'").get()).toEqual({ m: "manual" });
    // a later automatic attempt must not replace it
    const again = await linkSource({ db, hc }, "koreader", "d", { isbn: "9780593135204" });
    expect(again.hardcoverBookId).toBe(777);
  });

  it("best-guess: links the matching search hit when ids/ISBN are missing", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({
      search: async () => [
        { id: 111, title: "Rebecca's Secret", author: "Someone Else", users: 5000 },
        { id: 263530, title: "Rebecca", author: "Daphne du Maurier", users: 90000 },
      ],
    });
    const r = await linkSource({ db, hc }, "koreader", "d", {}, { title: "Rebecca", authors: ["Daphne Du Maurier"] });
    expect(r).toMatchObject({ status: "linked", method: "auto-title", hardcoverBookId: 263530 });
    expect(r.message).toContain("guessed from title");
    expect(db.prepare("SELECT method m FROM links").get()).toEqual({ m: "auto-title" });
  });

  it("best-guess: a same-main-title but different book is suggested, not linked", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ search: async () => [{ id: 5, title: "Dune", author: "Frank Herbert", users: 99 }] });
    const r = await linkSource({ db, hc }, "koreader", "d", {}, { title: "Dune: Messiah", authors: ["Frank Herbert"] });
    expect(r.status).toBe("unresolved");
    expect(db.prepare("SELECT count(*) n FROM links").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT hardcover_book_id h, title FROM suggestions WHERE source_id='d'").get()).toEqual({ h: 5, title: "Dune" });
  });

  it("best-guess: refuses a wrong-author or dissimilar result", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({
      search: async () => [
        { id: 1, title: "Rebecca", author: "Different Author", users: 99 },
        { id: 2, title: "Completely Unrelated Book", author: "Daphne du Maurier", users: 99 },
      ],
    });
    const r = await linkSource({ db, hc }, "koreader", "d", {}, { title: "Rebecca", authors: ["Daphne Du Maurier"] });
    expect(r.status).toBe("unresolved");
    expect(db.prepare("SELECT count(*) n FROM links").get()).toEqual({ n: 0 });
  });

  it("best-guess is only a fallback: ISBN wins and search is not called", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    const spy = vi.spyOn(hc, "search");
    const r = await linkSource({ db, hc }, "koreader", "d", { isbn: "9780593135204" }, { title: "x", authors: [] });
    expect(r.method).toBe("calibre-isbn");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports Hardcover failures without creating a link", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ editionByIsbn: async () => { throw new Error("boom"); } });
    const r = await linkSource({ db, hc }, "koreader", "d", { isbn: "9780593135204" });
    expect(r.status).toBe("error");
    expect(db.prepare("SELECT count(*) n FROM links").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM activity WHERE level='error'").get()).toEqual({ n: 1 });
  });
});
