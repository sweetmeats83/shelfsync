import { describe, it, expect, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { HardcoverClient, classifyEdition, type HardcoverRW, type HcEdition, type HcState, type ReadWrite } from "../src/hardcover.js";
import { ProgressEngine, decide, pickEdition, effectiveProgress, throttleAllows, todayIn, type DecideInput } from "../src/progress.js";

// ---- decide / throttle (pure) ----------------------------------------------

const hcNone: HcState = { userBookId: null, statusId: null, openReads: [] };
const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  pct: 0.5,
  finished: false,
  book: { pages: 400, editionId: 9, lastPct: null, lastAt: null },
  hc: hcNone,
  now: 10_000,
  today: "2026-11-02",
  ...over,
});

describe("throttleAllows", () => {
  it("first push, then >=1pp growth, or any growth after 15 min; never backwards", () => {
    expect(throttleAllows(0.1, { pct: null, at: null }, 0)).toBe(true);
    expect(throttleAllows(0.505, { pct: 0.5, at: 0 }, 60)).toBe(false); // 1 min
    expect(throttleAllows(0.9, { pct: 0.5, at: 0 }, 599)).toBe(false); // big jump, still inside 10 min
    expect(throttleAllows(0.501, { pct: 0.5, at: 0 }, 600)).toBe(true); // any growth after 10 min
    expect(throttleAllows(0.501, { pct: 0.5, at: 0 }, 120, 60)).toBe(true); // custom interval
    expect(throttleAllows(0.5, { pct: 0.5, at: 0 }, 5000)).toBe(false); // no growth
    expect(throttleAllows(0.3, { pct: 0.5, at: 0 }, 5000)).toBe(false); // backwards
  });
});

describe("decide", () => {
  it("locks (does nothing else) when Hardcover already shows Read", () => {
    expect(decide(base({ hc: { userBookId: 1, statusId: 3, openReads: [] } }))).toEqual({ lock: true });
    expect(decide(base({ finished: true, hc: { userBookId: 1, statusId: 3, openReads: [] } }))).toEqual({ lock: true });
  });

  it("starts an unshelved book: insert user_book as Currently Reading + insert a read with today's start date", () => {
    const p = decide(base());
    expect(p.status).toEqual({ kind: "insert", statusId: 2 });
    expect(p.read).toEqual({ mode: "insert", write: { pages: 200, editionId: 9, startedAt: "2026-11-02", finishedAt: null } });
  });

  it("moves Want-to-Read to Currently Reading, but leaves a book already Reading alone", () => {
    expect(decide(base({ hc: { userBookId: 7, statusId: 1, openReads: [] } })).status).toEqual({ kind: "update", userBookId: 7, statusId: 2 });
    expect(decide(base({ hc: { userBookId: 7, statusId: 2, openReads: [] } })).status).toBeUndefined();
  });

  it("updates the open read and keeps its original start date", () => {
    const p = decide(base({ hc: { userBookId: 7, statusId: 2, openReads: [{ id: 55, startedAt: "2026-10-01", editionId: 9 }] } }));
    expect(p.read).toEqual({ mode: "update", readId: 55, write: { pages: 200, editionId: 9, startedAt: "2026-10-01", finishedAt: null } });
  });

  it("does not push when progress hasn't grown enough, and never goes backwards", () => {
    const hc: HcState = { userBookId: 7, statusId: 2, openReads: [{ id: 55, startedAt: "2026-10-01", editionId: 9 }] };
    const book = { pages: 400, editionId: 9, lastPct: 0.5, lastAt: 9_990 };
    expect(decide(base({ pct: 0.52, book, hc })).read).toBeUndefined(); // 10 seconds after the last push
    const later = { ...book, lastAt: 9_000 }; // 1000 s ago
    expect(decide(base({ pct: 0.2, book: later, hc })).read).toBeUndefined(); // backwards
    expect(decide(base({ pct: 0.52, book: later, hc })).read?.write.pages).toBe(208);
  });

  it("finishing: status Read, full pages, finished date; bypasses the throttle", () => {
    const hc: HcState = { userBookId: 7, statusId: 2, openReads: [{ id: 55, startedAt: "2026-10-01", editionId: 9 }] };
    const p = decide(base({ pct: 0.99, finished: true, book: { pages: 400, editionId: 9, lastPct: 0.985, lastAt: 9_999 }, hc }));
    expect(p.status).toEqual({ kind: "update", userBookId: 7, statusId: 3 });
    expect(p.read?.write).toEqual({ pages: 400, editionId: 9, startedAt: "2026-10-01", finishedAt: "2026-11-02" });
    expect(p.pushedPct).toBe(1);
  });

  it("after marking Read, Hardcover may have closed the read: don't write a duplicate", () => {
    const p = decide(base({ finished: true, afterStatusChange: true, hc: { userBookId: 7, statusId: 3, openReads: [] } }));
    expect(p.lock).toBeUndefined();
    expect(p.read).toBeUndefined();
    expect(p.pushedPct).toBe(1);
  });

  it("warns instead of writing when the edition has no page count", () => {
    const p = decide(base({ book: { pages: null, editionId: null, lastPct: null, lastAt: null } }));
    expect(p.status).toBeDefined(); // status still managed
    expect(p.read).toBeUndefined();
    expect(p.warn).toMatch(/page count/);
  });

  it("does nothing at 0%", () => {
    expect(decide(base({ pct: 0 }))).toEqual({});
  });
});

// ---- effectiveProgress ------------------------------------------------------

function seed(db: DB, opts: { locked?: number; pages?: number | null; status?: number | null } = {}) {
  db.prepare(
    `INSERT INTO books (id, hardcover_book_id, hardcover_edition_id, title, pages, hc_status, locked_finished)
     VALUES (1, 100, 9, 'Test Book', @pages, @status, @locked)`,
  ).run({ pages: opts.pages === undefined ? 400 : opts.pages, status: opts.status ?? null, locked: opts.locked ?? 0 });
  db.prepare("INSERT INTO links VALUES ('koreader','docA',1,'manual',0)").run();
  db.prepare("INSERT INTO links VALUES ('koreader','docB',1,'manual',0)").run();
}
const put = (db: DB, document: string, device_id: string, pct: number, t: number) =>
  db
    .prepare("INSERT OR REPLACE INTO progress (user_id, document, device, device_id, progress, percentage, updated_at) VALUES (1,?,?,?,?,?,?)")
    .run(document, device_id, device_id, "x", pct, t);

describe("effectiveProgress", () => {
  it("uses the newest row per document, and the furthest document", () => {
    const db = openDb(":memory:");
    seed(db);
    put(db, "docA", "kobo", 0.7, 100);
    put(db, "docA", "phone", 0.4, 200); // newest on docA is 0.4 (user went back)
    put(db, "docB", "palm", 0.55, 150);
    expect(effectiveProgress(db, 1)).toEqual({ pct: 0.55, finished: false, leader: "koreader" });
  });

  it("counts ABS progress and either source finishing", () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO links VALUES ('abs','item1',1,'abs-isbn',0)").run();
    put(db, "docA", "kobo", 0.3, 100);
    db.prepare("INSERT INTO abs_progress (item_id, progress, current_time, duration, is_finished, last_update) VALUES ('item1', 0.8, 10, 100, 0, 1)").run();
    expect(effectiveProgress(db, 1)).toEqual({ pct: 0.8, finished: false, leader: "abs" });
    db.prepare("UPDATE abs_progress SET is_finished = 1").run();
    expect(effectiveProgress(db, 1).finished).toBe(true);
    const db2 = openDb(":memory:");
    seed(db2);
    put(db2, "docA", "kobo", 0.98, 100);
    expect(effectiveProgress(db2, 1).finished).toBe(true);
  });
});

// ---- the engine ------------------------------------------------------------

function fakeRw(state: Partial<HcState> = {}) {
  const st: HcState = { userBookId: null, statusId: null, openReads: [], ...state };
  const calls: string[] = [];
  const reads: ReadWrite[] = [];
  const rw: HardcoverRW = {
    readState: vi.fn(async () => {
      calls.push("readState");
      return structuredClone(st);
    }),
    insertUserBook: vi.fn(async (_b, status) => {
      calls.push(`insertUserBook:${status}`);
      st.userBookId = 500;
      st.statusId = status;
      return { dryRun: false, id: 500 };
    }),
    updateUserBookStatus: vi.fn(async (_id, status) => {
      calls.push(`updateStatus:${status}`);
      st.statusId = status;
      if (status === 3) st.openReads = []; // Hardcover closes the read when marked Read
      return { dryRun: false, id: 500 };
    }),
    insertRead: vi.fn(async (ub, r) => {
      calls.push(`insertRead:${r.pages}`);
      reads.push(r);
      st.openReads = [{ id: 600, startedAt: r.startedAt, editionId: r.editionId }];
      return { dryRun: false, id: 600 };
    }),
    updateRead: vi.fn(async (id, r) => {
      calls.push(`updateRead:${r.pages}`);
      reads.push(r);
      return { dryRun: false, id };
    }),
  };
  return { rw, calls, reads, st };
}

function engine(db: DB, rw: HardcoverRW, over: { dryRun?: boolean; now?: () => number } = {}) {
  return new ProgressEngine({ db, rw, dryRun: over.dryRun ?? false, tz: "America/Chicago", now: over.now ?? (() => 1_000_000) });
}
const row = (db: DB) => db.prepare("SELECT * FROM books WHERE id = 1").get() as any;

describe("ProgressEngine (live mode, fake Hardcover)", () => {
  it("starts a book, then skips tiny updates without touching Hardcover", async () => {
    const db = openDb(":memory:");
    seed(db);
    const { rw, calls } = fakeRw();
    let t = 1_000_000;
    const e = engine(db, rw, { now: () => t });

    put(db, "docA", "kobo", 0.1, t);
    await e.process(1);
    expect(calls).toEqual(["readState", "insertUserBook:2", "readState", "insertRead:40"]);
    expect(row(db)).toMatchObject({ hc_status: 2, hc_user_book_id: 500, hc_read_id: 600, last_pushed_pct: 0.1 });

    calls.length = 0;
    t += 60;
    put(db, "docA", "kobo", 0.103, t); // +0.3pp in one minute
    await e.process(1);
    expect(calls).toEqual([]); // gated locally: zero Hardcover traffic

    t += 60;
    put(db, "docA", "kobo", 0.12, t); // +2pp, but only 2 min after the last push
    await e.process(1);
    expect(calls).toEqual([]);

    t += 600;
    await e.process(1); // 10+ minutes since the push
    expect(calls).toEqual(["readState", "updateRead:48"]);
    e.stop();
  });

  it("re-checks on its own when the interval is up, so the last stretch of a session still syncs", async () => {
    vi.useFakeTimers();
    try {
      const db = openDb(":memory:");
      seed(db);
      const { rw, calls } = fakeRw();
      const e = engine(db, rw, { now: () => Math.floor(Date.now() / 1000) });
      put(db, "docA", "kobo", 0.1, Math.floor(Date.now() / 1000));
      await e.process(1);
      calls.length = 0;
      vi.advanceTimersByTime(60_000);
      put(db, "docA", "kobo", 0.2, Math.floor(Date.now() / 1000));
      await e.process(1); // too soon: nothing sent, a re-check is queued
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(calls).toEqual(["readState", "updateRead:80"]);
      e.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never moves Hardcover backwards when one device is behind", async () => {
    const db = openDb(":memory:");
    seed(db);
    const { rw, calls } = fakeRw();
    const e = engine(db, rw);
    put(db, "docA", "kobo", 0.5, 1_000_000);
    await e.process(1);
    calls.length = 0;
    put(db, "docA", "phone", 0.2, 1_000_100); // newer row but further back
    await e.process(1);
    expect(calls).toEqual([]);
    expect(row(db).last_pushed_pct).toBe(0.5);
  });

  it("the furthest source wins across KOReader and ABS", async () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO links VALUES ('abs','item1',1,'abs-isbn',0)").run();
    db.prepare("INSERT INTO abs_progress (item_id, progress, current_time, duration, is_finished, last_update) VALUES ('item1', 0.75, 1, 1, 0, 1)").run();
    const { rw, reads } = fakeRw();
    put(db, "docA", "kobo", 0.3, 1_000_000);
    await engine(db, rw).process(1);
    expect(reads[0]!.pages).toBe(300); // 75% of 400
  });

  it("finishing marks Read once, records the date, and then leaves the book alone", async () => {
    const db = openDb(":memory:");
    seed(db, { status: 2 });
    const { rw, calls } = fakeRw({ userBookId: 500, statusId: 2, openReads: [{ id: 600, startedAt: "2026-10-01", editionId: 9 }] });
    const e = engine(db, rw);
    put(db, "docA", "kobo", 0.99, 1_000_000);
    await e.process(1);
    expect(calls[0]).toBe("readState");
    expect(calls).toContain("updateStatus:3");
    expect(row(db)).toMatchObject({ locked_finished: 1, hc_status: 3, last_pushed_pct: 1 });
    expect(row(db).finished_at).toBe(todayIn("America/Chicago", 1_000_000));

    calls.length = 0;
    put(db, "docA", "kobo", 1.0, 1_000_500);
    await e.process(1);
    expect(calls).toEqual([]); // locked: nothing, not even a read
  });

  it("a book already Read on Hardcover is locked and never written", async () => {
    const db = openDb(":memory:");
    seed(db);
    const { rw, calls } = fakeRw({ userBookId: 500, statusId: 3 });
    put(db, "docA", "kobo", 0.4, 1_000_000);
    await engine(db, rw).process(1);
    expect(calls).toEqual(["readState"]);
    expect(row(db).locked_finished).toBe(1);
  });

  it("no page count: manages status, warns, and does not re-query on every sync", async () => {
    const db = openDb(":memory:");
    seed(db, { pages: null });
    const { rw, calls } = fakeRw();
    const e = engine(db, rw);
    put(db, "docA", "kobo", 0.3, 1_000_000);
    await e.process(1);
    expect(calls).toContain("insertUserBook:2");
    expect(calls.some((c) => c.startsWith("insertRead"))).toBe(false);
    expect(db.prepare("SELECT count(*) n FROM activity WHERE level='warn'").get()).toEqual({ n: 1 });
    calls.length = 0;
    put(db, "docA", "kobo", 0.301, 1_000_060);
    await e.process(1);
    expect(calls).toEqual([]);
  });

  it("a Hardcover failure is logged, not thrown, and retried on the next sync", async () => {
    const db = openDb(":memory:");
    seed(db);
    const { rw } = fakeRw();
    (rw.readState as any).mockRejectedValueOnce(new Error("boom"));
    const e = engine(db, rw);
    put(db, "docA", "kobo", 0.3, 1_000_000);
    await e.process(1);
    expect(db.prepare("SELECT count(*) n FROM activity WHERE level='error'").get()).toEqual({ n: 1 });
    await e.process(1); // next sync works
    expect(row(db).last_pushed_pct).toBe(0.3);
  });

  it("unlinked documents are logged once and ignored", () => {
    const db = openDb(":memory:");
    const { rw, calls } = fakeRw();
    const e = engine(db, rw);
    e.notifyDocument("mystery");
    e.notifyDocument("mystery");
    expect(calls).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM activity WHERE message LIKE 'Unlinked%'").get()).toEqual({ n: 1 });
  });
});

describe("edition by format", () => {
  const eds: HcEdition[] = [
    { id: 1, label: "Hardcover", format: "physical", pages: 300, audioSeconds: null },
    { id: 2, label: "Audible Audio", format: "audio", pages: null, audioSeconds: 36000 },
    { id: 3, label: "Kindle Edition", format: "ebook", pages: 310, audioSeconds: null },
  ];

  it("classifies by label and length, not Hardcover's unreliable format id", () => {
    expect(classifyEdition({ label: "Kindle Edition", audioSeconds: null, readingFormatId: 1 })).toBe("ebook");
    expect(classifyEdition({ label: "Audible Audio", audioSeconds: null })).toBe("audio");
    expect(classifyEdition({ label: null, audioSeconds: 500 })).toBe("audio");
    expect(classifyEdition({ label: "Paperback", audioSeconds: null })).toBe("physical");
  });

  it("picks the right edition for the format", () => {
    expect(pickEdition(eds, "audio")?.id).toBe(2);
    expect(pickEdition(eds, "ebook")?.id).toBe(3);
    expect(pickEdition(eds.slice(0, 1), "ebook")?.id).toBe(1); // physical is the fallback
    expect(pickEdition(eds.slice(0, 1), "audio")).toBeNull();
  });

  it("writes audio progress in seconds and leaves ebook progress in pages", () => {
    const audio = decide(base({ pct: 0.5, book: { pages: null, audioSeconds: 36000, isAudio: true, editionId: 2, lastPct: null, lastAt: null } }));
    expect(audio.read?.write).toMatchObject({ pages: null, seconds: 18000, editionId: 2 });
    const ebook = decide(base({ pct: 0.5, book: { pages: 400, editionId: 3, lastPct: null, lastAt: null } }));
    expect(ebook.read?.write).toMatchObject({ pages: 200, editionId: 3 });
    expect(ebook.read?.write.seconds).toBeUndefined();
  });

  it("retries the edition lookup after a failure instead of remembering it as done", async () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO links VALUES ('abs','item1',1,'abs-isbn',0)").run();
    db.prepare("INSERT INTO abs_progress (item_id, progress, current_time, duration, is_finished, last_update) VALUES ('item1', 0.5, 10, 100, 0, 1)").run();
    const { rw } = fakeRw();
    rw.editionsForBook = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValue(eds);
    const e = engine(db, rw);
    await e.process(1);
    expect(row(db).edition_tried).toBeNull();
    await e.process(1);
    expect(row(db)).toMatchObject({ hardcover_edition_id: 2, edition_format: "audio" });
  });

  it("switches to the audiobook edition when listening leads, and not when picked by hand", async () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO links VALUES ('abs','item1',1,'abs-isbn',0)").run();
    db.prepare("INSERT INTO abs_progress (item_id, progress, current_time, duration, is_finished, last_update) VALUES ('item1', 0.5, 10, 100, 0, 1)").run();
    const { rw, reads } = fakeRw();
    rw.editionsForBook = vi.fn(async () => eds);
    await engine(db, rw).process(1);
    expect(row(db)).toMatchObject({ hardcover_edition_id: 2, edition_format: "audio", audio_seconds: 36000 });
    expect(reads[0]).toMatchObject({ pages: null, seconds: 18000, editionId: 2 });

    const db2 = openDb(":memory:");
    seed(db2);
    db2.prepare("UPDATE books SET edition_manual = 1 WHERE id = 1").run();
    db2.prepare("INSERT INTO links VALUES ('abs','item1',1,'abs-isbn',0)").run();
    db2.prepare("INSERT INTO abs_progress (item_id, progress, current_time, duration, is_finished, last_update) VALUES ('item1', 0.5, 10, 100, 0, 1)").run();
    const f2 = fakeRw();
    f2.rw.editionsForBook = vi.fn(async () => eds);
    await engine(db2, f2.rw).process(1);
    expect(f2.rw.editionsForBook).not.toHaveBeenCalled();
    expect(row(db2).hardcover_edition_id).toBe(9);
  });
});

describe("DRY_RUN", () => {
  it("never calls a write method's real side effects for state: real columns stay untouched and logs don't repeat", async () => {
    const db = openDb(":memory:");
    seed(db);
    // dry client behaviour: every write reports dryRun
    const calls: string[] = [];
    const rw: HardcoverRW = {
      readState: async () => ({ userBookId: null, statusId: null, openReads: [] }),
      insertUserBook: async (_b, s) => (calls.push(`insertUserBook:${s}`), { dryRun: true }),
      updateUserBookStatus: async () => ({ dryRun: true }),
      insertRead: async (ub, r) => (calls.push(`insertRead:${ub}:${r.pages}`), { dryRun: true }),
      updateRead: async () => ({ dryRun: true }),
    };
    const e = engine(db, rw, { dryRun: true });
    put(db, "docA", "kobo", 0.25, 1_000_000);
    await e.process(1);
    expect(calls).toEqual(["insertUserBook:2", "insertRead:null:100"]);
    expect(row(db)).toMatchObject({ last_pushed_pct: null, hc_status: null, locked_finished: 0, dry_pct: 0.25 });

    calls.length = 0;
    put(db, "docA", "kobo", 0.251, 1_000_030);
    await e.process(1);
    expect(calls).toEqual([]); // throttled on dry bookkeeping

    // finishing in dry-run logs once, never locks
    put(db, "docA", "kobo", 0.99, 1_000_100);
    await e.process(1);
    await e.process(1);
    expect(calls.filter((c) => c.startsWith("insertRead:null:400"))).toHaveLength(1);
    expect(row(db).locked_finished).toBe(0);
    expect(row(db).last_pushed_pct).toBeNull();
  });

  it("flipping DRY_RUN off afterwards pushes for real (dry state doesn't count as pushed)", async () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("UPDATE books SET dry_pct = 0.9, dry_at = 5, dry_finished = 0").run();
    const { rw, calls } = fakeRw();
    put(db, "docA", "kobo", 0.5, 1_000_000);
    await engine(db, rw, { dryRun: false }).process(1);
    expect(calls).toContain("insertRead:200");
  });

  it("HardcoverClient: mutations are never sent while dry (default), but reads still are", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { me: [{ user_books: [] }] } })));
    const seen: { name: string; variables: any }[] = [];
    const c = new HardcoverClient({ token: "t", fetchFn, minIntervalMs: 0, sleep: async () => {}, onDryRun: (name, _q, variables) => seen.push({ name, variables }) });
    expect(await c.insertUserBook(1, 2)).toEqual({ dryRun: true });
    expect(await c.updateUserBookStatus(5, 3)).toEqual({ dryRun: true });
    expect(await c.insertRead(null, { pages: 1, editionId: 2, startedAt: "2026-01-01", finishedAt: null })).toEqual({ dryRun: true });
    expect(await c.updateRead(9, { pages: 1, editionId: 2, startedAt: "2026-01-01", finishedAt: null })).toEqual({ dryRun: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(seen.map((s) => s.name)).toEqual(["insert_user_book", "update_user_book", "insert_user_book_read", "update_user_book_read"]);
    await c.readState(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("HardcoverClient: when live, a mutation is sent and must be confirmed", async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { insert_user_book: { user_book: { id: 42 } } } })));
    const live = new HardcoverClient({ token: "t", fetchFn: ok, dryRun: false, minIntervalMs: 0, sleep: async () => {} });
    expect(await live.insertUserBook(1, 2)).toEqual({ dryRun: false, id: 42 });
    const empty = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { insert_user_book: null } })));
    const flaky = new HardcoverClient({ token: "t", fetchFn: empty, dryRun: false, minIntervalMs: 0, sleep: async () => {} });
    await expect(flaky.insertUserBook(1, 2)).rejects.toThrow(/not confirmed/);
  });
});
