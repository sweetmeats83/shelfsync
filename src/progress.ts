import { logActivity } from "./activity.js";
import type { DB } from "./db.js";
import type { EditionKind, HardcoverRW, HcEdition, HcState, ReadWrite, WriteResult } from "./hardcover.js";

/** The format of the edition a book is using now; older rows are inferred from what's stored. */
export function currentKind(b: { edition_format: EditionKind | null; pages: number | null; audio_seconds: number | null }): EditionKind | null {
  return b.edition_format ?? (b.pages ? "ebook" : b.audio_seconds ? "audio" : null);
}

/** Best edition for the format being used: audio needs a length; ebook needs pages (a physical edition is the fallback). */
export function pickEdition(editions: HcEdition[], wanted: "audio" | "ebook"): HcEdition | null {
  if (wanted === "audio") return editions.find((e) => e.format === "audio" && e.audioSeconds) ?? null;
  return (
    editions.find((e) => e.format === "ebook" && e.pages) ?? editions.find((e) => e.format === "physical" && e.pages) ?? null
  );
}

export const STATUS_READING = 2;
export const STATUS_READ = 3;
export const FINISHED_AT = 0.98; // KOReader percentage that counts as finished
const DEFAULT_PUSH_INTERVAL = 10 * 60; // seconds between progress pushes for one book (finishing is immediate)

// ---- Effective progress -----------------------------------------------------

/** Furthest progress across every source linked to this book (rule 3 and 4). */
export function effectiveProgress(
  db: DB,
  bookId: number,
): { pct: number; finished: boolean; startedAt?: number; finishedAt?: number; leader: "koreader" | "abs" | null } {
  let pct = 0;
  let koPct = 0;
  let absPct = 0;
  let finished = false;
  let startedAt: number | undefined;
  let finishedAt: number | undefined;

  // Newest row per KOReader document (all devices), then the furthest document.
  const rows = db
    .prepare(
      `SELECT p.document, p.percentage FROM links l JOIN progress p ON p.document = l.source_id
       WHERE l.source = 'koreader' AND l.book_id = ? ORDER BY p.updated_at DESC`,
    )
    .all(bookId) as { document: string; percentage: number | null }[];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.document)) continue;
    seen.add(r.document);
    const v = Math.min(1, Math.max(0, r.percentage ?? 0));
    pct = Math.max(pct, v);
    koPct = Math.max(koPct, v);
    if (v >= FINISHED_AT) finished = true;
  }

  const abs = db
    .prepare(
      `SELECT a.progress, a.is_finished, a.started_at, a.finished_at FROM links l JOIN abs_progress a ON a.item_id = l.source_id
       WHERE l.source = 'abs' AND l.book_id = ?`,
    )
    .all(bookId) as { progress: number | null; is_finished: number; started_at: number | null; finished_at: number | null }[];
  for (const a of abs) {
    const v = a.is_finished ? 1 : Math.min(1, Math.max(0, a.progress ?? 0));
    pct = Math.max(pct, Math.min(1, Math.max(0, a.progress ?? 0)));
    absPct = Math.max(absPct, v);
    if (a.is_finished) finished = true;
    // Real dates from ABS, so a book finished months ago isn't stamped with today's date.
    if (a.started_at) startedAt = Math.min(startedAt ?? a.started_at, a.started_at);
    if (a.is_finished && a.finished_at) finishedAt = Math.max(finishedAt ?? 0, a.finished_at);
  }
  // Whichever source is furthest along decides the format; a tie goes to the ebook.
  const leader = absPct > koPct ? "abs" : koPct > 0 ? "koreader" : null;
  return { pct, finished, startedAt, finishedAt, leader };
}

// ---- The decision (pure) ----------------------------------------------------

export interface BookFacts {
  pages: number | null;
  /** Set when the edition in use is an audiobook: progress is then written in seconds. */
  audioSeconds?: number | null;
  isAudio?: boolean;
  editionId: number | null;
  lastPct: number | null;
  lastAt: number | null;
}

export interface DecideInput {
  pct: number;
  finished: boolean;
  book: BookFacts;
  hc: HcState;
  now: number; // unix seconds
  today: string; // YYYY-MM-DD in the owner's timezone
  /** Dates the source reported (YYYY-MM-DD); today is only the fallback. */
  startedOn?: string;
  finishedOn?: string;
  /** Second pass after a real status change, with freshly fetched Hardcover state. */
  afterStatusChange?: boolean;
}

export interface Plan {
  /** Hardcover already shows this book as Read: leave it alone from now on. */
  lock?: boolean;
  status?: { kind: "insert" | "update"; userBookId?: number; statusId: number };
  read?: { mode: "insert" | "update"; readId?: number; write: ReadWrite };
  /** Progress value to remember as "last pushed" if the read write goes through. */
  pushedPct?: number;
  warn?: string;
}

/** Whether the growth since the last push is enough to push again (rule 7). Finished bypasses it. */
export function throttleAllows(
  pct: number,
  last: { pct: number | null; at: number | null },
  now: number,
  intervalSec: number = DEFAULT_PUSH_INTERVAL,
): boolean {
  if (last.pct == null) return pct > 0;
  if (pct <= last.pct) return false; // never backwards, never repeat
  return last.at == null || now - last.at >= intervalSec; // at most one progress push per interval
}

export function decide(i: DecideInput): Plan {
  // Rule 5. (Not on the second pass: then "Read" is the status we just set ourselves.)
  if (i.hc.statusId === STATUS_READ && !i.afterStatusChange) return { lock: true };
  if (!i.finished && i.pct <= 0) return {};

  const plan: Plan = {};
  const target = i.finished ? STATUS_READ : STATUS_READING;

  if (!i.afterStatusChange) {
    if (i.hc.userBookId == null) plan.status = { kind: "insert", statusId: target };
    else if (i.hc.statusId !== target) plan.status = { kind: "update", userBookId: i.hc.userBookId, statusId: target };
  }

  const push = i.finished || throttleAllows(i.pct, { pct: i.book.lastPct, at: i.book.lastAt }, i.now);
  if (!push) return plan;

  // Marking a book Read makes Hardcover close its open read; writing another would duplicate it.
  if (i.afterStatusChange && i.finished && i.hc.openReads.length === 0) {
    plan.pushedPct = 1;
    return plan;
  }
  const audio = !!i.book.isAudio;
  const total = audio ? i.book.audioSeconds : i.book.pages;
  if (!total || !i.book.editionId) {
    plan.warn = audio
      ? "Hardcover has no length for this audiobook edition, so progress can't sync (status still does)"
      : "Hardcover has no page count for this edition, so progress can't sync (status still does)";
    return plan;
  }
  const amount = i.finished ? total : Math.min(total, Math.max(0, Math.floor(i.pct * total)));
  const open = i.hc.openReads[0];
  const write: ReadWrite = {
    pages: audio ? null : amount,
    seconds: audio ? amount : undefined,
    editionId: i.book.editionId,
    startedAt: open?.startedAt || i.startedOn || i.today, // the mutation replaces the record: always carry the start date
    finishedAt: i.finished ? i.finishedOn || i.today : null,
  };
  plan.read = open ? { mode: "update", readId: open.id, write } : { mode: "insert", write };
  plan.pushedPct = i.finished ? 1 : i.pct;
  return plan;
}

// ---- The engine -------------------------------------------------------------

interface BookRow {
  id: number;
  hardcover_book_id: number;
  title: string;
  pages: number | null;
  audio_seconds: number | null;
  edition_format: EditionKind | null;
  edition_manual: number;
  edition_tried: string | null;
  hardcover_edition_id: number | null;
  hc_status: number | null;
  last_pushed_pct: number | null;
  last_pushed_at: number | null;
  locked_finished: number;
  dry_pct: number | null;
  dry_at: number | null;
  dry_finished: number;
}

export interface EngineDeps {
  db: DB;
  rw: HardcoverRW;
  dryRun: boolean;
  tz: string;
  now?: () => number;
  /** Minimum seconds between progress pushes for one book (default 600). */
  pushIntervalSec?: number;
}

export function todayIn(tz: string, nowSec: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(nowSec * 1000),
  ); // en-CA formats as YYYY-MM-DD
}

export class ProgressEngine {
  private running = new Set<number>();
  private dirty = new Set<number>();
  private warnedUnlinked = new Map<string, number>();

  constructor(private d: EngineDeps) {}

  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  private now() {
    return this.d.now ? this.d.now() : Math.floor(Date.now() / 1000);
  }

  private interval() {
    return this.d.pushIntervalSec ?? DEFAULT_PUSH_INTERVAL;
  }

  /** One pending re-check per book. */
  private later(bookId: number, seconds: number): void {
    if (this.timers.has(bookId)) return;
    const t = setTimeout(() => {
      this.timers.delete(bookId);
      this.schedule(bookId);
    }, Math.max(1, seconds + 1) * 1000);
    t.unref?.();
    this.timers.set(bookId, t);
  }

  /** Cancel pending re-checks (tests / shutdown). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Called after every KOSync PUT. Never blocks the caller. */
  notifyDocument(document: string): void {
    this.notify("koreader", document);
  }

  notify(source: "koreader" | "abs", sourceId: string): void {
    const link = this.d.db.prepare("SELECT book_id FROM links WHERE source = ? AND source_id = ?").get(source, sourceId) as
      | { book_id: number }
      | undefined;
    if (!link) {
      const key = `${source}:${sourceId}`;
      const last = this.warnedUnlinked.get(key) ?? 0;
      if (this.now() - last > 3600) {
        this.warnedUnlinked.set(key, this.now());
        logActivity(this.d.db, { level: "warn", source, message: `Unlinked progress for ${source} ${sourceId} (no Hardcover link yet)` });
      }
      return;
    }
    this.schedule(link.book_id);
  }

  /** Serialize work per book; progress that arrives mid-push triggers one follow-up pass. */
  private schedule(bookId: number): void {
    if (this.running.has(bookId)) {
      this.dirty.add(bookId);
      return;
    }
    this.running.add(bookId);
    void (async () => {
      try {
        do {
          this.dirty.delete(bookId);
          await this.process(bookId);
        } while (this.dirty.has(bookId));
      } finally {
        this.running.delete(bookId);
      }
    })();
  }

  /** Switch to the edition matching the format being used (listening vs reading), unless one was picked by hand. */
  private async ensureEdition(book: BookRow, leader: "koreader" | "abs" | null): Promise<void> {
    if (!leader || book.edition_manual || !this.d.rw.editionsForBook) return;
    const wanted = leader === "abs" ? "audio" : "ebook";
    if (book.edition_format === wanted || book.edition_tried === wanted) return;
    const all = await this.d.rw.editionsForBook(book.hardcover_book_id); // a failure here is retried next sync
    this.d.db.prepare("UPDATE books SET edition_tried = ? WHERE id = ?").run(wanted, book.id);
    // Learn what the edition we already use actually is, whether or not we switch.
    const cur = all.find((e) => e.id === book.hardcover_edition_id);
    if (cur) {
      this.d.db.prepare("UPDATE books SET edition_format = ?, edition_label = ? WHERE id = ?").run(cur.format, cur.label, book.id);
      if (cur.format === wanted) return;
    }
    const pick = pickEdition(all, wanted);
    if (!pick || pick.id === book.hardcover_edition_id) return;
    if (wanted === "ebook" && pick.format === "physical" && cur?.format === "physical") return; // nothing better exists
    this.d.db
      .prepare(
        "UPDATE books SET hardcover_edition_id = ?, pages = ?, audio_seconds = ?, edition_format = ?, edition_label = ? WHERE id = ?",
      )
      .run(pick.id, pick.pages, pick.audioSeconds, pick.format, pick.label, book.id);
    logActivity(this.d.db, {
      source: "engine",
      bookId: book.id,
      message: `"${book.title}": using the ${pick.label ?? pick.format} edition (${wanted === "audio" ? "you're listening" : "you're reading"})`,
    });
  }

  async process(bookId: number): Promise<void> {
    const { db, rw, dryRun } = this.d;
    try {
      let book = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as BookRow | undefined;
      if (!book || book.locked_finished) return;
      const now = this.now();
      const { pct, finished, startedAt, finishedAt, leader } = effectiveProgress(db, bookId);

      const last = dryRun ? { pct: book.dry_pct, at: book.dry_at } : { pct: book.last_pushed_pct, at: book.last_pushed_at };
      const alreadyFinishedInDry = dryRun && !!book.dry_finished;
      const startedKnown = book.hc_status === STATUS_READING || (dryRun && book.dry_pct != null);

      // Cheap local gate: most KOReader PUTs need no Hardcover traffic at all.
      if (alreadyFinishedInDry) return;
      if (!finished && pct <= 0) return;
      if (!finished && startedKnown && !throttleAllows(pct, last, now, this.interval())) {
        // Progress is ahead of what we pushed but too soon: come back when the interval is up,
        // so the last stretch of a session isn't left unsynced when no further updates arrive.
        if (last.pct != null && pct > last.pct && last.at != null) this.later(bookId, last.at + this.interval() - now);
        return;
      }

      await this.ensureEdition(book, leader);
      book = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as BookRow;
      const hc = await rw.readState(book.hardcover_book_id);
      const today = todayIn(this.d.tz, now);
      const facts: BookFacts = {
        pages: book.pages,
        audioSeconds: book.audio_seconds,
        isAudio: book.edition_format === "audio" || (book.edition_format == null && !book.pages && !!book.audio_seconds),
        editionId: book.hardcover_edition_id,
        lastPct: last.pct,
        lastAt: last.at,
      };
      const startedOn = startedAt ? todayIn(this.d.tz, startedAt) : undefined;
      const finishedOn = finishedAt ? todayIn(this.d.tz, finishedAt) : undefined;
      let plan = decide({ pct, finished, book: facts, hc, now, today, startedOn, finishedOn });

      if (plan.lock) {
        db.prepare("UPDATE books SET locked_finished = 1, hc_status = ?, hc_user_book_id = ? WHERE id = ?").run(STATUS_READ, hc.userBookId, bookId);
        logActivity(db, { source: "engine", bookId, message: `"${book.title}" is already Read on Hardcover: leaving it alone` });
        return;
      }

      let userBookId = hc.userBookId;
      if (plan.status) {
        const res: WriteResult =
          plan.status.kind === "insert"
            ? await rw.insertUserBook(book.hardcover_book_id, plan.status.statusId)
            : await rw.updateUserBookStatus(plan.status.userBookId!, plan.status.statusId);
        const label = plan.status.statusId === STATUS_READ ? "Read" : "Currently Reading";
        if (res.dryRun) {
          logActivity(db, { source: "engine", bookId, message: `[dry-run] would set "${book.title}" to ${label}` });
        } else {
          if (plan.status.kind === "insert") userBookId = res.id;
          db.prepare("UPDATE books SET hc_status = ?, hc_user_book_id = ? WHERE id = ?").run(plan.status.statusId, userBookId, bookId);
          logActivity(db, { source: "engine", bookId, message: `Set "${book.title}" to ${label}` });
          // Hardcover may have auto-created or closed a read: re-plan from fresh state.
          const fresh = await rw.readState(book.hardcover_book_id);
          plan = { ...decide({ pct, finished, book: facts, hc: fresh, now, today, startedOn, finishedOn, afterStatusChange: true }), status: plan.status };
        }
      }

      if (plan.warn) logActivity(db, { level: "warn", source: "engine", bookId, message: `"${book.title}": ${plan.warn}` });

      if (plan.read) {
        const { mode, readId, write } = plan.read;
        const res = mode === "update" ? await rw.updateRead(readId!, write) : await rw.insertRead(userBookId, write);
        const amount = write.seconds != null ? `${write.seconds}/${book.audio_seconds} s (audio)` : `${write.pages}/${book.pages} pages`;
        const what = `${amount} (${Math.round((plan.pushedPct ?? pct) * 100)}%)${write.finishedAt ? `, finished ${write.finishedAt}` : ""}`;
        if (res.dryRun) {
          logActivity(db, { source: "engine", bookId, message: `[dry-run] would ${mode} read for "${book.title}": ${what}` });
        } else {
          db.prepare("UPDATE books SET hc_read_id = ? WHERE id = ?").run(res.id, bookId);
          logActivity(db, { source: "engine", bookId, message: `Pushed "${book.title}": ${what}` });
        }
      }

      // Anything we acted on (or warned about) counts for the throttle, so a book that can't
      // push progress doesn't hit Hardcover on every sync. `pushedPct` is undefined only on a warning.
      const handled = plan.read !== undefined || plan.pushedPct !== undefined || plan.warn !== undefined;
      if (handled) {
        const recorded = plan.pushedPct ?? pct;
        if (dryRun) {
          db.prepare("UPDATE books SET dry_pct = ?, dry_at = ?, dry_finished = ? WHERE id = ?").run(recorded, now, finished ? 1 : 0, bookId);
        } else if (finished) {
          db.prepare(
            "UPDATE books SET last_pushed_pct = 1, last_pushed_at = ?, finished_at = ?, hc_status = ?, locked_finished = 1 WHERE id = ?",
          ).run(now, finishedOn ?? today, STATUS_READ, bookId);
          logActivity(db, { source: "engine", bookId, message: `"${book.title}" finished: locked` });
        } else {
          db.prepare("UPDATE books SET last_pushed_pct = ?, last_pushed_at = ? WHERE id = ?").run(recorded, now, bookId);
        }
      } else if (dryRun && plan.status) {
        // Remember that the start was logged, so we don't repeat it on every sync.
        db.prepare("UPDATE books SET dry_pct = COALESCE(dry_pct, 0.0001), dry_at = COALESCE(dry_at, ?) WHERE id = ?").run(now, bookId);
      }
    } catch (e) {
      logActivity(this.d.db, {
        level: "error",
        source: "engine",
        bookId,
        message: `Progress push failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
