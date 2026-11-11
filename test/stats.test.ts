import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { computeStats } from "../src/stats.js";

const T0 = Date.UTC(2026, 10, 2, 15, 0, 0) / 1000; // Mon 2 Nov 2026, 15:00 UTC
const min = 60;

function setup() {
  const db = openDb(":memory:");
  const book = (id: number, title: string, author: string, format: string | null, finished: string | null) =>
    db
      .prepare("INSERT INTO books (id, hardcover_book_id, title, author, edition_format, finished_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, 1000 + id, title, author, format, finished);
  book(1, "Rebecca", "Daphne du Maurier", "ebook", "2026-11-03");
  book(2, "My Cousin Rachel", "Daphne du Maurier", "audio", null);
  book(3, "Dune", "Frank Herbert", "ebook", "2025-06-01");
  const link = (source: string, id: string, bookId: number) =>
    db.prepare("INSERT INTO links (source, source_id, book_id, method, created_at) VALUES (?, ?, ?, 'manual', 0)").run(source, id, bookId);
  link("koreader", "docA", 1);
  link("abs", "li2", 2);
  link("koreader", "docC", 3);
  const ev = (ts: number, source: string, sid: string, dev: string, pct: number, seconds: number | null = null, pulled = 0) =>
    db
      .prepare("INSERT INTO reading_events (ts, source, source_id, device_id, device, pct, seconds, pulled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ts, source, sid, dev, dev, pct, seconds, pulled);
  const prog = (doc: string, dev: string, pct: number, at: number) =>
    db.prepare("INSERT INTO progress (user_id, document, device, device_id, progress, percentage, updated_at) VALUES (1, ?, ?, ?, 'x', ?, ?)").run(doc, dev, dev, pct, at);
  return { db, ev, prog };
}

describe("computeStats", () => {
  it("counts reading time within a sitting, ignores long gaps and pulled positions", () => {
    const { db, ev, prog } = setup();
    ev(T0, "koreader", "docA", "kobo", 0.1);
    ev(T0 + 10 * min, "koreader", "docA", "kobo", 0.12); // +10 min reading
    ev(T0 + 20 * min, "koreader", "docA", "kobo", 0.14); // +10 min
    ev(T0 + 5 * 3600, "koreader", "docA", "kobo", 0.2); // next sitting: progress counts, the gap doesn't
    ev(T0 + 6 * 3600, "koreader", "docA", "phone", 0.05);
    ev(T0 + 6 * 3600 + 5 * min, "koreader", "docA", "phone", 0.2, null, 1); // jumped to the Kobo's spot: not reading
    prog("docA", "kobo", 0.2, T0 + 5 * 3600);
    prog("docA", "phone", 0.2, T0 + 6 * 3600);
    const s = computeStats(db, "UTC", T0 + 7 * 3600);
    expect(s.totals.readingSeconds).toBe(20 * min);
    const kobo = s.devices.find((d) => d.id === "kobo")!;
    expect(kobo).toMatchObject({ seconds: 20 * min, books: 1 });
    expect(kobo.pctRead).toBeCloseTo(0.1);
    expect(s.devices.find((d) => d.id === "phone")).toMatchObject({ seconds: 0, pctRead: 0 });
    expect(s.weekdays.find((w) => w.day === "Mon")!.seconds).toBe(20 * min);
    expect(s.books[0]).toMatchObject({ id: 1, seconds: 20 * min });
  });

  it("credits audiobook listening by position moved, not wall-clock, and skips jumps", () => {
    const { db, ev } = setup();
    ev(T0, "abs", "li2", "abs", 0.1, 1000);
    ev(T0 + 3600, "abs", "li2", "abs", 0.2, 1000 + 1800); // 30 min listened over an hour
    ev(T0 + 3700, "abs", "li2", "abs", 0.9, 30000); // skipped ahead: not listening
    const s = computeStats(db, "UTC", T0 + 4000);
    expect(s.totals.listeningSeconds).toBe(1800);
    expect(s.listeningFromAbs).toBe(false);
  });

  it("prefers Audiobookshelf's own listening history when available", () => {
    const { db } = setup();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('abs_listening_stats', ?, 0)").run(
      JSON.stringify({ totalTime: 7200, days: { "2026-11-01": 3600, "2026-11-02": 3600 }, items: { li2: 7200 } }),
    );
    const s = computeStats(db, "UTC", T0);
    expect(s.listeningFromAbs).toBe(true);
    expect(s.totals.listeningSeconds).toBe(7200);
    expect(s.months.at(-1)).toMatchObject({ month: "2026-11", listeningSeconds: 7200 });
    expect(s.books[0]).toMatchObject({ id: 2, seconds: 7200 });
    expect(s.streak).toEqual({ current: 2, longest: 2 });
    expect(s.devices.find((d) => d.id === "abs")).toMatchObject({ name: "Audiobookshelf", seconds: 7200 });
  });

  it("finished books by year, format and month; authors ranked by books", () => {
    const { db } = setup();
    const s = computeStats(db, "UTC", T0 + 2 * 86400);
    expect(s.totals).toMatchObject({ finished: 2, finishedThisYear: 1, booksTracked: 3 });
    expect(s.totals.finishedByFormat).toEqual({ ebook: 2 });
    expect(s.months).toHaveLength(12);
    expect(s.months.at(-1)).toMatchObject({ month: "2026-11", finished: 1 });
    expect(s.authors[0]).toMatchObject({ author: "Daphne du Maurier", books: 2, finished: 1 });
  });

  it("streak survives a day with nothing yet today", () => {
    const { db, ev } = setup();
    for (const d of [0, 1, 2]) {
      ev(T0 + d * 86400, "koreader", "docA", "kobo", 0.1 + d * 0.1);
      ev(T0 + d * 86400 + 5 * min, "koreader", "docA", "kobo", 0.15 + d * 0.1);
    }
    expect(computeStats(db, "UTC", T0 + 3 * 86400).streak).toEqual({ current: 3, longest: 3 });
    expect(computeStats(db, "UTC", T0 + 5 * 86400).streak).toEqual({ current: 0, longest: 3 });
  });
});
