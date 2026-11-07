import { logActivity } from "./activity.js";
import type { DB } from "./db.js";
import type { HardcoverApi } from "./hardcover.js";
import { hardcoverHints, type Calibre } from "./calibre.js";
import { linkSource } from "./identification.js";
import { storedMatch } from "./libraryMatch.js";

/**
 * Your Calibre library knows the Hardcover id for books you own, so match the audiobook to it by
 * title and author and reuse that id: far more reliable than searching all of Hardcover.
 * Only the book id is taken (not the edition), because Calibre's edition is the ebook.
 */
export function calibreHints(db: DB, calibre: Calibre | null | undefined, title: string, authors: string[]) {
  if (!calibre || !title || !authors.length) return null;
  try {
    const book = calibre.byTitleAuthor(title, authors);
    if (!book) return null;
    const own = hardcoverHints(calibre.identifiers(book.id));
    const id = own.hardcover_book_id ?? storedMatch(db, book.id)?.hardcover_book_id;
    return id ? { hardcover_book_id: id, via: "calibre-hardcover-id" as const } : null;
  } catch {
    return null; // Calibre unreadable: carry on with the audiobook's own ISBN/ASIN
  }
}

/**
 * Audiobookshelf poller. Strictly read-only toward ABS (GET only).
 * Endpoints: GET /api/me (mediaProgress[]) and GET /api/items/:id (media.metadata).
 */

export interface AbsDeps {
  db: DB;
  url: string;
  token: string;
  hc: HardcoverApi | null;
  /** Optional: lets audiobooks reuse the Hardcover id Calibre already holds for the same title. */
  calibre?: Calibre | null;
  /** Items not updated within this many days are ignored entirely (default 7). */
  maxAgeDays?: number;
  /** Called for every changed item that already has (or just got) a link. */
  onChange?: (itemId: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface AbsPollResult {
  ok: boolean;
  seen: number;
  changed: number;
  error?: string;
}

interface MediaProgress {
  libraryItemId?: string;
  episodeId?: string | null;
  progress?: number;
  currentTime?: number;
  duration?: number;
  isFinished?: boolean;
  lastUpdate?: number; // ms
  startedAt?: number; // ms
  finishedAt?: number; // ms
}

const toSec = (ms: unknown): number | null => (typeof ms === "number" && ms > 0 ? Math.floor(ms / 1000) : null);

/** ABS returns authors as `authorName` (minified) or an `authors: [{name}]` array depending on the endpoint. */
function authorsOf(md: any): string[] {
  if (Array.isArray(md?.authors)) {
    const names = md.authors.map((a: any) => (typeof a === "string" ? a : a?.name)).filter(Boolean);
    if (names.length) return names;
  }
  return splitAuthors(md?.authorName);
}

const RELINK_AFTER_SEC = 6 * 3600; // retry an unlinked item at most this often unless its progress changed
const attempted = new Map<string, number>();
let lastError = "";

/** For the dashboard. */
export const absStatus: { lastPollAt: number | null; ok: boolean | null; error: string | null } = {
  lastPollAt: null,
  ok: null,
  error: null,
};

async function getJson(d: AbsDeps, path: string): Promise<any> {
  const f = d.fetchFn ?? fetch;
  const res = await f(`${d.url}${path}`, {
    headers: { Authorization: `Bearer ${d.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ABS ${path} → HTTP ${res.status}`);
  return res.json();
}

function splitAuthors(name: unknown): string[] {
  if (typeof name !== "string") return [];
  return name
    .split(/\s*(?:,|&|;| and )\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function pollAbs(d: AbsDeps): Promise<AbsPollResult> {
  const now = d.now ? d.now() : Math.floor(Date.now() / 1000);
  let me: any;
  try {
    me = await getJson(d, "/api/me");
    lastError = "";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== lastError) {
      lastError = msg;
      logActivity(d.db, { level: "error", source: "abs", message: `Audiobookshelf poll failed: ${msg}` });
    }
    Object.assign(absStatus, { lastPollAt: now, ok: false, error: msg });
    return { ok: false, seen: 0, changed: 0, error: msg };
  }
  Object.assign(absStatus, { lastPollAt: now, ok: true, error: null });

  const list: MediaProgress[] = Array.isArray(me?.mediaProgress) ? me.mediaProgress : [];
  let seen = 0;
  let changed = 0;

  for (const mp of list) {
    const id = mp.libraryItemId;
    if (!id || mp.episodeId) continue; // books only; skip podcast episodes
    // Backlog guard: only books you've touched recently. Old items are never stored, linked or sent.
    if (!mp.lastUpdate || now - Math.floor(mp.lastUpdate / 1000) > (d.maxAgeDays ?? 7) * 86400) continue;
    seen++;
    const progress = Math.min(1, Math.max(0, Number(mp.progress ?? 0)));
    const finished = mp.isFinished ? 1 : 0;
    const lastUpdate = mp.lastUpdate ? Math.floor(mp.lastUpdate / 1000) : null;

    const prev = d.db.prepare("SELECT last_update, is_finished, started_at, finished_at FROM abs_progress WHERE item_id = ?").get(id) as
      | { last_update: number | null; is_finished: number; started_at: number | null; finished_at: number | null }
      | undefined;
    const isChanged =
      !prev ||
      prev.last_update !== lastUpdate ||
      prev.is_finished !== finished ||
      prev.started_at !== toSec(mp.startedAt) ||
      prev.finished_at !== toSec(mp.finishedAt);
    if (isChanged) {
      d.db
        .prepare(
          `INSERT INTO abs_progress (item_id, progress, current_time, duration, is_finished, last_update, started_at, finished_at)
           VALUES (@id, @progress, @ct, @dur, @fin, @lu, @sa, @fa)
           ON CONFLICT (item_id) DO UPDATE SET progress=@progress, current_time=@ct, duration=@dur, is_finished=@fin,
             last_update=@lu, started_at=@sa, finished_at=@fa`,
        )
        .run({
          id,
          progress,
          ct: mp.currentTime ?? null,
          dur: mp.duration ?? null,
          fin: finished,
          lu: lastUpdate,
          sa: toSec(mp.startedAt),
          fa: toSec(mp.finishedAt),
        });
      changed++;
    }

    // Untouched items (0%, not finished) are never linked: that would send the whole ABS library to Hardcover.
    if (progress <= 0 && !finished) continue;

    let linked = !!d.db.prepare("SELECT 1 FROM links WHERE source = 'abs' AND source_id = ?").get(id);
    const wasLinked = linked;
    if (!linked && d.hc) {
      const last = attempted.get(id) ?? 0;
      if (isChanged || now - last > RELINK_AFTER_SEC) {
        attempted.set(id, now);
        try {
          const item = await getJson(d, `/api/items/${encodeURIComponent(id)}`);
          const md = item?.media?.metadata ?? {};
          const title = String(md.title ?? "").trim();
          // Remember the name so the web UI can show unmatched items.
          d.db.prepare("UPDATE abs_progress SET title = ?, author = ? WHERE item_id = ?").run(title || null, authorsOf(md).join(", ") || null, id);
          const res = await linkSource(
            { db: d.db, hc: d.hc },
            "abs",
            id,
            { isbn: md.isbn || undefined, asin: md.asin || undefined, ...calibreHints(d.db, d.calibre, title, authorsOf(md)) },
            // No author known → don't guess by title alone (many books share titles); leave it for manual linking.
            title && authorsOf(md).length ? { title, authors: authorsOf(md) } : undefined,
          );
          linked = res.status === "linked";
        } catch (e) {
          logActivity(d.db, {
            level: "warn",
            source: "abs",
            message: `Could not look up ABS item ${id}: ${e instanceof Error ? e.message : e}`,
          });
        }
      }
    }
    // Also when a retry just linked an item whose progress hasn't changed since: its progress was never pushed.
    if (linked && (isChanged || !wasLinked)) d.onChange?.(id);
  }

  // Give every stored item a name (for the web UI), a few per poll. Failures are retried next poll.
  const nameless = d.db.prepare("SELECT item_id FROM abs_progress WHERE title IS NULL LIMIT 10").all() as { item_id: string }[];
  for (const { item_id } of nameless) {
    try {
      const md = (await getJson(d, `/api/items/${encodeURIComponent(item_id)}`))?.media?.metadata ?? {};
      const title = String(md.title ?? "").trim();
      if (title) {
        d.db.prepare("UPDATE abs_progress SET title = ?, author = ? WHERE item_id = ?").run(title, authorsOf(md).join(", ") || null, item_id);
      } else {
        d.db.prepare("UPDATE abs_progress SET title = '(untitled)' WHERE item_id = ?").run(item_id);
      }
    } catch {
      break; // ABS unreachable or item deleted: stop for this poll
    }
  }

  if (changed) logActivity(d.db, { source: "abs", message: `Audiobookshelf: ${changed} item(s) changed of ${seen}` });
  return { ok: true, seen, changed };
}

/** Test hook. */
export function resetAbsState(): void {
  attempted.clear();
  lastError = "";
}
