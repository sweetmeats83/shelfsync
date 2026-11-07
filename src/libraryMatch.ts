import { logActivity } from "./activity.js";
import { hardcoverHints, type Calibre } from "./calibre.js";
import type { DB } from "./db.js";
import { HardcoverError, type HardcoverApi } from "./hardcover.js";
import { toIsbn13 } from "./identification.js";
import { pickBest } from "./matching.js";

const DAY = 86400;
const RETRY_NOMATCH_AFTER = 30 * DAY;
const RETRY_ERROR_AFTER = 3600;

export interface BatchStats {
  total: number;
  skipped: number;
  matched: number;
  nomatch: number;
  errors: number;
  aborted?: string;
  /** Set when the run stopped for a reason that should clear soon (rate limit). */
  retryAfterSec?: number;
}

const LOCK = "library-match";
const LEASE_SEC = 120;

/** Cross-process lease so the background job and the CLI never run together. */
function acquire(db: DB, now: number): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT until FROM job_locks WHERE name = ?").get(LOCK) as { until: number } | undefined;
    if (row && row.until > now) return false;
    db.prepare("INSERT INTO job_locks (name, until) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET until = excluded.until").run(LOCK, now + LEASE_SEC);
    return true;
  })();
}
const renew = (db: DB, now: number) => db.prepare("UPDATE job_locks SET until = ? WHERE name = ?").run(now + LEASE_SEC, LOCK);
const release = (db: DB) => db.prepare("DELETE FROM job_locks WHERE name = ?").run(LOCK);

/**
 * Resolve a Hardcover book for every Calibre book and store it in ShelfSync's
 * own database. READ-ONLY toward Calibre and Hardcover: it never writes to
 * either. Resumable: books already matched are skipped, so it only does new work.
 */
export async function matchLibrary(
  deps: { db: DB; calibre: Calibre; hc: HardcoverApi },
  opts: { limit?: number; now?: () => number } = {},
): Promise<BatchStats> {
  const { db, calibre, hc } = deps;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const stats: BatchStats = { total: 0, skipped: 0, matched: 0, nomatch: 0, errors: 0 };
  if (!acquire(db, now())) return { ...stats, aborted: "already running (in the server or another process)" };

  const save = db.prepare(
    `INSERT INTO calibre_matches (calibre_book_id, status, hardcover_book_id, hardcover_edition_id, method, score, detail, updated_at)
     VALUES (@id, @status, @hid, @eid, @method, @score, @detail, @now)
     ON CONFLICT (calibre_book_id) DO UPDATE SET status = excluded.status, hardcover_book_id = excluded.hardcover_book_id,
       hardcover_edition_id = excluded.hardcover_edition_id, method = excluded.method, score = excluded.score,
       detail = excluded.detail, updated_at = excluded.updated_at`,
  );
  const existing = new Map(
    (db.prepare("SELECT calibre_book_id id, status, updated_at t FROM calibre_matches").all() as {
      id: number;
      status: string;
      t: number;
    }[]).map((r) => [r.id, r]),
  );

  try {
    const books = calibre.listBooks();
    stats.total = books.length;
    let worked = 0;
    for (const b of books) {
      const prev = existing.get(b.id);
      const age = prev ? now() - prev.t : Infinity;
      if (prev && (prev.status === "matched" || (prev.status === "nomatch" && age < RETRY_NOMATCH_AFTER) || (prev.status === "error" && age < RETRY_ERROR_AFTER))) {
        stats.skipped++;
        continue;
      }
      if (opts.limit && worked >= opts.limit) break;
      worked++;
      renew(db, now());

      const row = { id: b.id, status: "nomatch", hid: null as number | null, eid: null as number | null, method: null as string | null, score: null as number | null, detail: null as string | null, now: now() };
      try {
        const hints = hardcoverHints(b.identifiers);
        const isbn = hints.isbn ? toIsbn13(hints.isbn) : null;
        if (hints.hardcover_book_id) {
          Object.assign(row, { status: "matched", hid: hints.hardcover_book_id, eid: hints.hardcover_edition_id ?? null, method: "calibre-hardcover-id" });
        } else {
          const edition = isbn ? await hc.editionByIsbn(isbn) : null;
          if (edition) {
            Object.assign(row, { status: "matched", hid: edition.bookId, eid: edition.id, method: "calibre-isbn" });
          } else {
            const hits = await hc.search(`${b.title} ${b.authors[0] ?? ""}`.trim());
            const pick = pickBest({ title: b.title, authors: b.authors }, hits);
            if (pick) {
              Object.assign(row, {
                status: "matched",
                hid: pick.hit.id,
                method: "auto-title",
                score: pick.score,
                detail: JSON.stringify({ matched: pick.hit.title, author: pick.hit.author, runnersUp: pick.runnersUp }),
              });
            } else {
              row.detail = `no acceptable match among ${hits.length} results`;
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        row.status = "error";
        row.detail = msg;
        stats.errors++;
        // A bad/revoked token or a persistent rate limit won't fix itself mid-run: stop and retry later.
        if (e instanceof HardcoverError && (e.status === 401 || e.status === 403 || e.status === 429)) {
          save.run(row);
          stats.aborted = msg;
          if (e.status === 429) stats.retryAfterSec = 600; // rate limits clear; auth problems need a human
          break;
        }
      }
      save.run(row);
      if (row.status === "matched") stats.matched++;
      else if (row.status === "nomatch") stats.nomatch++;

      if (worked % 25 === 0) {
        logActivity(db, { source: "library", message: `Library match: ${worked} processed (${stats.matched} matched, ${stats.nomatch} unmatched, ${stats.errors} errors)` });
      }
    }
    logActivity(db, {
      level: stats.aborted ? "warn" : "info",
      source: "library",
      message: `Library match done: ${stats.matched} matched, ${stats.nomatch} unmatched, ${stats.errors} errors, ${stats.skipped} already done of ${stats.total}${stats.aborted ? ` — stopped: ${stats.aborted}` : ""}`,
    });
    return stats;
  } finally {
    release(db);
  }
}

/** Stored answer for a Calibre book, in the shape linkSource expects. */
export function storedMatch(db: DB, calibreBookId: number) {
  const r = db
    .prepare("SELECT hardcover_book_id hid, hardcover_edition_id eid, method FROM calibre_matches WHERE calibre_book_id = ? AND status = 'matched'")
    .get(calibreBookId) as { hid: number; eid: number | null; method: string } | undefined;
  return r
    ? { hardcover_book_id: r.hid, hardcover_edition_id: r.eid ?? undefined, via: r.method as "calibre-hardcover-id" | "calibre-isbn" | "auto-title" }
    : null;
}
