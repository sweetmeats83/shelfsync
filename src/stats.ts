import type { DB } from "./db.js";
import { todayIn } from "./progress.js";

/** Two progress reports further apart than this are separate sittings: the gap isn't counted as reading time. */
export const SESSION_GAP_SEC = 30 * 60;

export interface Stats {
  /** When ShelfSync started recording progress history (time-based stats only cover from here). */
  since: number | null;
  totals: {
    booksTracked: number;
    finished: number;
    finishedThisYear: number;
    finishedByFormat: Record<string, number>;
    highlights: number;
    readingSeconds: number;
    listeningSeconds: number;
    activeDays: number;
  };
  streak: { current: number; longest: number };
  /** True when listening time comes from Audiobookshelf's own history (complete), not just what ShelfSync saw. */
  listeningFromAbs: boolean;
  authors: { author: string; books: number; finished: number; highlights: number; seconds: number }[];
  books: { id: number; title: string; author: string | null; coverUrl: string | null; seconds: number; highlights: number; finished: boolean }[];
  devices: { id: string; name: string; books: number; seconds: number; pctRead: number; lastSeen: number | null }[];
  months: { month: string; finished: number; readingSeconds: number; listeningSeconds: number }[];
  weekdays: { day: string; seconds: number }[];
}

interface Ev {
  ts: number;
  source: string;
  source_id: string;
  device_id: string;
  device: string | null;
  pct: number | null;
  seconds: number | null;
  pulled: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const splitAuthors = (a: string | null) =>
  (a ?? "")
    .split(/\s*(?:,|&|;| and )\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);

function lastMonths(tz: string, nowSec: number, n: number): string[] {
  const [y, m] = todayIn(tz, nowSec).split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

function streaks(days: Set<string>, today: string): { current: number; longest: number } {
  let longest = 0;
  for (const d of days) {
    if (days.has(dayBefore(d))) continue; // not the start of a run
    let len = 1;
    const next = new Date(`${d}T12:00:00Z`);
    for (;;) {
      next.setUTCDate(next.getUTCDate() + 1);
      if (!days.has(next.toISOString().slice(0, 10))) break;
      len++;
    }
    longest = Math.max(longest, len);
  }
  // A streak is still alive if today has nothing yet but yesterday did.
  let cur = 0;
  let d = days.has(today) ? today : dayBefore(today);
  while (days.has(d)) {
    cur++;
    d = dayBefore(d);
  }
  return { current: cur, longest };
}

export function computeStats(db: DB, tz: string, nowSec = Math.floor(Date.now() / 1000)): Stats {
  const links = db.prepare("SELECT source, source_id, book_id FROM links").all() as { source: string; source_id: string; book_id: number }[];
  const bookOf = new Map(links.map((l) => [`${l.source}:${l.source_id}`, l.book_id]));
  const books = db
    .prepare("SELECT id, title, author, cover_url, edition_format, finished_at FROM books")
    .all() as { id: number; title: string; author: string | null; cover_url: string | null; edition_format: string | null; finished_at: string | null }[];
  const names = new Map(
    (db.prepare("SELECT device_id, name FROM device_names").all() as { device_id: string; name: string }[]).map((r) => [r.device_id, r.name]),
  );

  const day = (ts: number) => todayIn(tz, ts);
  const readBook = new Map<number, number>();
  const listenBook = new Map<number, number>();
  const readMonth = new Map<string, number>();
  const listenMonth = new Map<string, number>();
  const readWeekday = new Map<number, number>();
  let listenWeekday = new Map<number, number>();
  const weekdayOf = (ts: number) => (new Date(`${day(ts)}T12:00:00Z`).getUTCDay() + 6) % 7;
  const devSeconds = new Map<string, number>();
  const devPct = new Map<string, number>();
  const devLabel = new Map<string, string>();
  const activeDays = new Set<string>();
  const touched = new Set<number>();

  // Walk each device's reports for each book in time order and credit the forward movement.
  const events = db
    .prepare("SELECT ts, source, source_id, device_id, device, pct, seconds, pulled FROM reading_events ORDER BY source, source_id, device_id, ts")
    .all() as Ev[];
  const since = events.length ? Math.min(...events.map((e) => e.ts)) : null;
  let prev: Ev | null = null;
  for (const e of events) {
    devLabel.set(e.device_id, names.get(e.device_id) ?? e.device ?? e.device_id);
    const same = prev && prev.source === e.source && prev.source_id === e.source_id && prev.device_id === e.device_id;
    const p = same ? prev! : null;
    prev = e;
    const bookId = bookOf.get(`${e.source}:${e.source_id}`);
    if (bookId) touched.add(bookId);
    if (!p || e.pulled) continue;
    const dPct = (e.pct ?? 0) - (p.pct ?? 0);
    const dt = e.ts - p.ts;
    if (dPct <= 0 || dt <= 0) continue;
    activeDays.add(day(e.ts));
    add(devPct, e.device_id, dPct);
    let secs = 0;
    if (e.source === "abs") {
      const dPos = (e.seconds ?? 0) - (p.seconds ?? 0);
      if (dPos > 0 && dPos <= dt * 3.5 + 120) secs = dPos; // ≤ 3.5x playback speed, else it was a skip
    } else if (dt <= SESSION_GAP_SEC) {
      secs = dt;
    }
    if (!secs) continue;
    add(devSeconds, e.device_id, secs);
    if (e.source === "abs") {
      add(listenWeekday, weekdayOf(e.ts), secs);
      add(listenMonth, day(e.ts).slice(0, 7), secs);
      if (bookId) add(listenBook, bookId, secs);
    } else {
      add(readWeekday, weekdayOf(e.ts), secs);
      add(readMonth, day(e.ts).slice(0, 7), secs);
      if (bookId) add(readBook, bookId, secs);
    }
  }

  // Audiobookshelf's own listening history is complete and exact: prefer it when we have it.
  const ls = db.prepare("SELECT value FROM kv WHERE key = 'abs_listening_stats'").get() as { value: string } | undefined;
  let listeningFromAbs = false;
  let absTotal = 0;
  if (ls) {
    try {
      const v = JSON.parse(ls.value) as { totalTime: number; days: Record<string, number>; items: Record<string, number> };
      listeningFromAbs = true;
      absTotal = v.totalTime;
      listenBook.clear();
      listenMonth.clear();
      for (const [id, secs] of Object.entries(v.items)) {
        const bookId = bookOf.get(`abs:${id}`);
        if (bookId && secs > 0) add(listenBook, bookId, secs);
      }
      listenWeekday = new Map();
      for (const [d, secs] of Object.entries(v.days)) {
        if (!(Number(secs) > 0)) continue;
        add(listenMonth, d.slice(0, 7), Number(secs));
        add(listenWeekday, (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7, Number(secs));
        activeDays.add(d);
      }
      devSeconds.set("abs", absTotal);
      devLabel.set("abs", "Audiobookshelf");
    } catch {
      listeningFromAbs = false;
    }
  }

  // Highlights per book.
  const hl = db
    .prepare(
      `SELECT l.book_id, COUNT(*) n FROM highlights h JOIN links l ON l.source = 'koreader' AND l.source_id = h.document GROUP BY l.book_id`,
    )
    .all() as { book_id: number; n: number }[];
  const hlBook = new Map(hl.map((r) => [r.book_id, r.n]));
  const highlights = (db.prepare("SELECT COUNT(*) n FROM highlights").get() as { n: number }).n;

  // Books that have any activity or a link from a source are "tracked".
  for (const l of links) touched.add(l.book_id);
  const year = todayIn(tz, nowSec).slice(0, 4);
  const finishedByFormat: Record<string, number> = {};
  const finishedMonth = new Map<string, number>();
  let finished = 0;
  let finishedThisYear = 0;
  for (const b of books) {
    if (!b.finished_at) continue;
    finished++;
    if (b.finished_at.startsWith(year)) finishedThisYear++;
    const f = b.edition_format ?? "unknown";
    finishedByFormat[f] = (finishedByFormat[f] ?? 0) + 1;
    add(finishedMonth, b.finished_at.slice(0, 7), 1);
  }

  const secondsOf = (id: number) => (readBook.get(id) ?? 0) + (listenBook.get(id) ?? 0);
  const tracked = books.filter((b) => touched.has(b.id));

  const authorMap = new Map<string, { author: string; books: number; finished: number; highlights: number; seconds: number }>();
  for (const b of tracked) {
    for (const name of splitAuthors(b.author)) {
      const key = name.toLowerCase();
      const a = authorMap.get(key) ?? { author: name, books: 0, finished: 0, highlights: 0, seconds: 0 };
      a.books++;
      if (b.finished_at) a.finished++;
      a.highlights += hlBook.get(b.id) ?? 0;
      a.seconds += secondsOf(b.id);
      authorMap.set(key, a);
    }
  }
  const authors = [...authorMap.values()]
    .sort((x, y) => y.books - x.books || y.finished - x.finished || y.seconds - x.seconds || x.author.localeCompare(y.author))
    .slice(0, 10);

  const topBooks = tracked
    .map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      coverUrl: b.cover_url,
      seconds: Math.round(secondsOf(b.id)),
      highlights: hlBook.get(b.id) ?? 0,
      finished: !!b.finished_at,
    }))
    .filter((b) => b.seconds > 0 || b.highlights > 0)
    .sort((x, y) => y.seconds - x.seconds || y.highlights - x.highlights)
    .slice(0, 10);

  // Devices: books seen per device come from the progress table, so they cover the time before history was kept.
  const devRows = db
    .prepare("SELECT device_id, device, COUNT(DISTINCT document) books, MAX(updated_at) last FROM progress GROUP BY device_id")
    .all() as { device_id: string; device: string | null; books: number; last: number }[];
  const devices: Stats["devices"] = devRows.map((r) => ({
    id: r.device_id,
    name: names.get(r.device_id) ?? r.device ?? r.device_id,
    books: r.books,
    seconds: Math.round(devSeconds.get(r.device_id) ?? 0),
    pctRead: Number((devPct.get(r.device_id) ?? 0).toFixed(3)),
    lastSeen: r.last,
  }));
  const absItems = db.prepare("SELECT COUNT(*) n, MAX(last_update) last FROM abs_progress").get() as { n: number; last: number | null };
  if (absItems.n || devSeconds.get("abs")) {
    devices.push({
      id: "abs",
      name: "Audiobookshelf",
      books: absItems.n,
      seconds: Math.round(devSeconds.get("abs") ?? 0),
      pctRead: Number((devPct.get("abs") ?? 0).toFixed(3)),
      lastSeen: absItems.last,
    });
  }
  devices.sort((x, y) => y.seconds - x.seconds || y.books - x.books);

  const sum = (m: Map<unknown, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const today = todayIn(tz, nowSec);
  return {
    since,
    totals: {
      booksTracked: tracked.length,
      finished,
      finishedThisYear,
      finishedByFormat,
      highlights,
      readingSeconds: Math.round(sum(readMonth)),
      listeningSeconds: Math.round(listeningFromAbs ? absTotal : sum(listenMonth)),
      activeDays: activeDays.size,
    },
    streak: streaks(activeDays, today),
    listeningFromAbs,
    authors: authors.map((a) => ({ ...a, seconds: Math.round(a.seconds) })),
    books: topBooks,
    devices,
    months: lastMonths(tz, nowSec, 12).map((m) => ({
      month: m,
      finished: finishedMonth.get(m) ?? 0,
      readingSeconds: Math.round(readMonth.get(m) ?? 0),
      listeningSeconds: Math.round(listenMonth.get(m) ?? 0),
    })),
    weekdays: WEEKDAYS.map((d, i) => ({ day: d, seconds: Math.round((readWeekday.get(i) ?? 0) + (listenWeekday.get(i) ?? 0)) })),
  };
}
