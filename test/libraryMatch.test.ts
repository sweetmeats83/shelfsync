import { describe, it, expect, vi } from "vitest";
import { openDb } from "../src/db.js";
import type { Calibre } from "../src/calibre.js";
import { HardcoverError, type HardcoverApi } from "../src/hardcover.js";
import { matchLibrary, storedMatch } from "../src/libraryMatch.js";
import { linkSource } from "../src/identification.js";

const lib = [
  { id: 1, title: "Rebecca", uuid: "u1", authors: ["Daphne du Maurier"], identifiers: { "hardcover-id": "263530", "hardcover-edition": "31879493" } },
  { id: 2, title: "Project Hail Mary", uuid: "u2", authors: ["Andy Weir"], identifiers: { isbn: "9780593135204" } },
  { id: 3, title: "Dune", uuid: "u3", authors: ["Frank Herbert"], identifiers: {} },
  { id: 4, title: "Totally Obscure Pamphlet", uuid: "u4", authors: ["Nobody"], identifiers: {} },
];
const calibre = { listBooks: () => lib } as unknown as Calibre;

function fakeHc(over: Partial<HardcoverApi> = {}): HardcoverApi {
  return {
    me: async () => ({ id: 1, username: "n" }),
    bookById: async (id) => ({ id, title: "T", author: "A", editions: [] }),
    editionById: async () => null,
    editionByIsbn: async () => ({ id: 900, bookId: 12345, pages: 476, audioSeconds: null, title: "Project Hail Mary", author: "Andy Weir" }),
    editionByAsin: async () => null,
    userBook: async () => null,
    search: async (q) =>
      q.startsWith("Dune") ? [{ id: 77, title: "Dune", author: "Frank Herbert", users: 9000 }] : [],
    ...over,
  };
}

describe("matchLibrary", () => {
  it("resolves ids, ISBNs and title guesses; leaves the unknown as nomatch", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    const idCalls = vi.spyOn(hc, "bookById");
    const s = await matchLibrary({ db, calibre, hc });
    expect(s).toMatchObject({ total: 4, matched: 3, nomatch: 1, errors: 0 });
    expect(idCalls).not.toHaveBeenCalled(); // an existing Hardcover id needs no API call
    const rows = db.prepare("SELECT calibre_book_id id, status, hardcover_book_id hid, method FROM calibre_matches ORDER BY 1").all();
    expect(rows).toEqual([
      { id: 1, status: "matched", hid: 263530, method: "calibre-hardcover-id" },
      { id: 2, status: "matched", hid: 12345, method: "calibre-isbn" },
      { id: 3, status: "matched", hid: 77, method: "auto-title" },
      { id: 4, status: "nomatch", hid: null, method: null },
    ]);
  });

  it("is resumable: a second run skips finished books and only retries after the window", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    await matchLibrary({ db, calibre, hc });
    const spy = vi.spyOn(hc, "search");
    const again = await matchLibrary({ db, calibre, hc });
    expect(again.skipped).toBe(4);
    expect(spy).not.toHaveBeenCalled();
    const later = await matchLibrary({ db, calibre, hc }, { now: () => Math.floor(Date.now() / 1000) + 31 * 86400 });
    expect(later.skipped).toBe(3); // the nomatch is retried after 30 days
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stops the run on an auth failure instead of marking everything as errors", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ search: async () => { throw new HardcoverError("rejected", 401); } });
    const s = await matchLibrary({ db, calibre, hc });
    expect(s.aborted).toBe("rejected");
    expect(db.prepare("SELECT count(*) n FROM calibre_matches").get()).toEqual({ n: 3 }); // 1,2 matched + 3 errored; 4 not reached
  });

  it("refuses to run twice at once (shared lease), then frees the lock", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    const first = matchLibrary({ db, calibre, hc }); // takes the lease synchronously
    const second = await matchLibrary({ db, calibre, hc });
    expect(second.aborted).toMatch(/already running/);
    await first;
    expect((await matchLibrary({ db, calibre, hc })).aborted).toBeUndefined(); // released
  });

  it("a rate-limit stop asks to be retried soon", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc({ search: async () => { throw new HardcoverError("rate", 429); } });
    const s = await matchLibrary({ db, calibre, hc });
    expect(s.retryAfterSec).toBe(600);
  });

  it("a stored guess is used at link time and labelled auto-title", async () => {
    const db = openDb(":memory:");
    const hc = fakeHc();
    await matchLibrary({ db, calibre, hc });
    const stored = storedMatch(db, 3);
    expect(stored).toMatchObject({ hardcover_book_id: 77, via: "auto-title" });
    const r = await linkSource({ db, hc }, "koreader", "doc", { ...stored! });
    expect(r).toMatchObject({ status: "linked", hardcoverBookId: 77, method: "auto-title" });
    expect(storedMatch(db, 4)).toBeNull();
  });
});
