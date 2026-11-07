import { logActivity } from "./activity.js";
import { surname } from "./calibre.js";
import type { DB } from "./db.js";
import type { HardcoverApi, EditionInfo } from "./hardcover.js";
import { AUTO_MIN_SCORE, pickBest, type Lookup } from "./matching.js";

export interface Hints {
  hardcover_book_id?: number;
  hardcover_edition_id?: number;
  isbn?: string;
  asin?: string;
  /** Link method to record when these ids came from the library-wide matcher. */
  via?: "calibre-hardcover-id" | "calibre-isbn" | "auto-title";
}

export type LinkMethod =
  | "calibre-hardcover-id"
  | "calibre-isbn"
  | "abs-isbn"
  | "abs-asin"
  | "auto-title" // best guess from a Hardcover title/author search; review in the UI
  | "manual";

export interface LinkResult {
  status: "linked" | "unresolved" | "error";
  message: string;
  bookId?: number;
  hardcoverBookId?: number;
  method?: LinkMethod;
  locked?: boolean;
}

const STATUS_READ = 3;

/** Strip separators; ISBN-10 -> ISBN-13. Returns null if it isn't a valid-looking ISBN. */
export function toIsbn13(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/.test(s)) {
    const core = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    return core + ((10 - (sum % 10)) % 10);
  }
  return null;
}

interface Resolved {
  hardcoverBookId: number;
  edition: EditionInfo | null;
  title: string;
  author: string | null;
  method: LinkMethod;
}

/** SQL: take the incoming edition only if none is set yet, or the stored one has no page count and the new one does. */
const USE_NEW_EDITION = `(books.edition_manual = 0 AND excluded.hardcover_edition_id IS NOT NULL
  AND (books.hardcover_edition_id IS NULL OR (books.pages IS NULL AND excluded.pages IS NOT NULL)))`;

/**
 * Link one source item (a KOReader document hash or an ABS item) to a Hardcover
 * book. Never uses fuzzy search. An existing link (especially a manual one) is
 * never overwritten.
 */
export async function linkSource(
  deps: { db: DB; hc: HardcoverApi },
  source: "koreader" | "abs",
  sourceId: string,
  hints: Hints,
  /** Title/authors for the best-guess fallback when ids and ISBN don't resolve. */
  lookup?: Lookup,
): Promise<LinkResult> {
  const { db, hc } = deps;

  const existing = db
    .prepare(
      `SELECT b.id, b.hardcover_book_id, b.title, b.locked_finished, l.method
       FROM links l JOIN books b ON b.id = l.book_id WHERE l.source = ? AND l.source_id = ?`,
    )
    .get(source, sourceId) as
    | { id: number; hardcover_book_id: number; title: string; locked_finished: number; method: LinkMethod }
    | undefined;
  if (existing) {
    return {
      status: "linked",
      message: `Linked: ${existing.title} (Hardcover #${existing.hardcover_book_id})`,
      bookId: existing.id,
      hardcoverBookId: existing.hardcover_book_id,
      method: existing.method,
      locked: !!existing.locked_finished,
    };
  }

  try {
    const noGuess = !!db.prepare("SELECT 1 FROM no_auto WHERE source = ? AND source_id = ?").get(source, sourceId);
    const r = (await resolve(hc, source, hints)) ?? (lookup && !noGuess ? await guess(deps, source, sourceId, lookup) : null);
    if (!r) {
      logActivity(db, { level: "warn", source, message: `Unmatched ${source} ${sourceId}: no usable Hardcover id/ISBN/ASIN`, payload: hints });
      const why = noGuess
        ? "you unlinked it earlier, so it won't be guessed again"
        : lookup
          ? `no confident Hardcover match for "${lookup.title}"`
          : "no Hardcover id, ISBN or title to match on";
      return { status: "unresolved", message: `Not linked: ${why}. Link it in the web UI (Unmatched).` };
    }

    // Prefer the edition the user already shelved; else the resolved edition; else a default with pages.
    const userBook = await hc.userBook(r.hardcoverBookId);
    const book = r.edition ? null : await hc.bookById(r.hardcoverBookId);
    const edition = userBook?.edition?.pages
      ? { id: userBook.edition.id, pages: userBook.edition.pages, audio: null as number | null }
      : r.edition
        ? { id: r.edition.id, pages: r.edition.pages, audio: r.edition.audioSeconds }
        : book?.editions[0]
          ? { id: book.editions[0].id, pages: book.editions[0].pages, audio: null }
          : null;
    const locked = userBook?.statusId === STATUS_READ ? 1 : 0;

    const bookRow = db.transaction(() => {
      db.prepare(
        `INSERT INTO books (hardcover_book_id, hardcover_edition_id, title, author, pages, audio_seconds, hc_user_book_id, hc_status, locked_finished)
         VALUES (@hid, @eid, @title, @author, @pages, @audio, @ubid, @status, @locked)
         ON CONFLICT (hardcover_book_id) DO UPDATE SET
           -- The edition and everything describing it change together, and never over a hand-picked edition.
           hardcover_edition_id = CASE WHEN ${USE_NEW_EDITION} THEN excluded.hardcover_edition_id ELSE books.hardcover_edition_id END,
           pages = CASE WHEN ${USE_NEW_EDITION} THEN excluded.pages ELSE books.pages END,
           audio_seconds = CASE WHEN ${USE_NEW_EDITION} THEN excluded.audio_seconds ELSE books.audio_seconds END,
           edition_format = CASE WHEN ${USE_NEW_EDITION} THEN NULL ELSE books.edition_format END,
           edition_label = CASE WHEN ${USE_NEW_EDITION} THEN NULL ELSE books.edition_label END,
           edition_tried = CASE WHEN ${USE_NEW_EDITION} THEN NULL ELSE books.edition_tried END,
           title = excluded.title, author = excluded.author,
           hc_user_book_id = COALESCE(excluded.hc_user_book_id, books.hc_user_book_id),
           hc_status = COALESCE(excluded.hc_status, books.hc_status),
           locked_finished = MAX(books.locked_finished, excluded.locked_finished)`,
      ).run({
        hid: r.hardcoverBookId,
        eid: edition?.id ?? null,
        title: r.title,
        author: r.author,
        pages: edition?.pages ?? null,
        audio: edition?.audio ?? null,
        ubid: userBook?.id ?? null,
        status: userBook?.statusId ?? null,
        locked,
      });
      const row = db.prepare("SELECT id, locked_finished FROM books WHERE hardcover_book_id = ?").get(r.hardcoverBookId) as {
        id: number;
        locked_finished: number;
      };
      db.prepare(
        "INSERT OR IGNORE INTO links (source, source_id, book_id, method, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(source, sourceId, row.id, r.method, Math.floor(Date.now() / 1000));
      return row;
    })();

    logActivity(db, {
      source,
      bookId: bookRow.id,
      message: `Linked ${source} ${sourceId} → "${r.title}" (Hardcover #${r.hardcoverBookId}) via ${r.method}${bookRow.locked_finished ? " [already Read: locked]" : ""}`,
      payload: { hints, edition },
    });
    return {
      status: "linked",
      message: `Linked: ${r.title} (Hardcover #${r.hardcoverBookId})${r.method === "auto-title" ? " — guessed from title" : ""}${bookRow.locked_finished ? " — already Read" : ""}`,
      bookId: bookRow.id,
      hardcoverBookId: r.hardcoverBookId,
      method: r.method,
      locked: !!bookRow.locked_finished,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logActivity(db, { level: "error", source, message: `Hardcover lookup failed for ${source} ${sourceId}: ${msg}`, payload: hints });
    return { status: "error", message: `Hardcover error: ${msg}` };
  }
}

/** Best-guess fallback: search Hardcover by title + author and take the best acceptable hit. */
async function guess(
  deps: { db: DB; hc: HardcoverApi },
  source: "koreader" | "abs",
  sourceId: string,
  lookup: Lookup,
): Promise<Resolved | null> {
  const hits = await deps.hc.search(`${lookup.title} ${lookup.authors[0] ?? ""}`.trim());
  // Always link the closest match: an imperfect link you can fix in the UI beats a book that never syncs.
  // Anything below AUTO_MIN_SCORE (and every last-resort pick) is listed under "guesses" for review.
  let pick = pickBest(lookup, hits);
  if (!pick) {
    // Nothing passed the title/author checks: fall back to Hardcover's own top result, preferring a matching author.
    const wantSurnames = new Set(lookup.authors.map(surname).filter(Boolean));
    const top = hits.find((h) => h.author && wantSurnames.has(surname(h.author))) ?? hits[0];
    if (!top) {
      logActivity(deps.db, {
        level: "warn",
        source,
        message: `No Hardcover results at all for "${lookup.title}"; link it by hand in the UI.`,
        payload: { lookup },
      });
      return null;
    }
    pick = { hit: top, score: 0, runnersUp: [] };
  }
  deps.db.prepare("DELETE FROM suggestions WHERE source = ? AND source_id = ?").run(source, sourceId);
  logActivity(deps.db, {
    level: pick.score < AUTO_MIN_SCORE ? "warn" : "info",
    source,
    message: `Best guess for "${lookup.title}" → "${pick.hit.title}" (Hardcover #${pick.hit.id}, score ${pick.score})${pick.score < AUTO_MIN_SCORE ? ": low confidence, check it under Books → guesses" : ""}`,
    payload: { sourceId, pick },
  });
  return { hardcoverBookId: pick.hit.id, edition: null, title: pick.hit.title, author: pick.hit.author, method: "auto-title" };
}

/**
 * Manually point a source item at a Hardcover book (replaces any existing link).
 * This is the one path allowed to override an automatic link.
 */
export async function manualLink(
  deps: { db: DB; hc: HardcoverApi },
  source: "koreader" | "abs",
  sourceId: string,
  hardcoverBookId: number,
): Promise<LinkResult> {
  const { db } = deps;
  const old = db.prepare("SELECT * FROM links WHERE source = ? AND source_id = ?").get(source, sourceId) as
    | { source: string; source_id: string; book_id: number; method: string; created_at: number }
    | undefined;
  db.prepare("DELETE FROM links WHERE source = ? AND source_id = ?").run(source, sourceId);
  const r = await linkSource(deps, source, sourceId, { hardcover_book_id: hardcoverBookId });
  if (r.status !== "linked" && old) {
    // The new target didn't resolve: put the working link back rather than leaving the item unlinked.
    db.prepare("INSERT OR IGNORE INTO links (source, source_id, book_id, method, created_at) VALUES (?, ?, ?, ?, ?)").run(
      old.source,
      old.source_id,
      old.book_id,
      old.method,
      old.created_at,
    );
  }
  if (r.status === "linked") {
    db.prepare("UPDATE links SET method = 'manual' WHERE source = ? AND source_id = ?").run(source, sourceId);
    logActivity(db, { source, bookId: r.bookId, message: `Manual link ${source} ${sourceId} → Hardcover #${hardcoverBookId}` });
    r.method = "manual";
  }
  return r;
}

/** Rule 2: Hardcover edition id → book id → ISBN (ebooks) / ISBN → ASIN (audio). First hit wins. */
async function resolve(hc: HardcoverApi, source: "koreader" | "abs", h: Hints): Promise<Resolved | null> {
  const fromEdition = (e: EditionInfo, method: LinkMethod): Resolved => ({
    hardcoverBookId: e.bookId,
    edition: e,
    title: e.title,
    author: e.author,
    method,
  });

  // Explicit Hardcover ids (from Calibre, or a manual link from the web UI) apply to either source.
  const via = h.via ?? "calibre-hardcover-id";
  if (h.hardcover_edition_id) {
    const e = await hc.editionById(h.hardcover_edition_id);
    if (e) return fromEdition(e, via);
  }
  if (h.hardcover_book_id) {
    const b = await hc.bookById(h.hardcover_book_id);
    if (b) return { hardcoverBookId: b.id, edition: null, title: b.title, author: b.author, method: via };
  }

  const isbn = h.isbn ? toIsbn13(h.isbn) : null;
  if (isbn) {
    const e = await hc.editionByIsbn(isbn);
    if (e) return fromEdition(e, source === "koreader" ? "calibre-isbn" : "abs-isbn");
  }
  if (source === "abs" && h.asin) {
    const e = await hc.editionByAsin(h.asin.trim());
    if (e) return fromEdition(e, "abs-asin");
  }
  return null;
}
