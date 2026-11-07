import { Hono } from "hono";
import type { DB } from "./db.js";
import { authenticate } from "./kosync.js";
import { hardcoverHints, type Calibre, type CalibreBook } from "./calibre.js";
import type { HardcoverApi } from "./hardcover.js";
import { linkSource, type Hints } from "./identification.js";
import { storedMatch } from "./libraryMatch.js";

export interface IdentifyOptions {
  db: DB;
  calibre: Calibre | null;
  /** Null when HARDCOVER_TOKEN isn't set; identification then stops at Calibre. */
  hardcover?: HardcoverApi | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Turns the `metadata` object a CrossPoint reader sends with progress into an identify request. */
export function fromKosyncMetadata(document: string, m: Record<string, unknown>) {
  const authors = Array.isArray(m.authors)
    ? m.authors
    : typeof m.authors === "string"
      ? m.authors.split(/;|\s&\s/).map((a) => a.trim()).filter(Boolean)
      : [];
  return { document, title: m.title, authors, isbn: m.isbn, filename: m.filename };
}

/** PUT /api/identify — the KOReader plugin tells us what a document hash is. */
export function identifyRoutes(opts: IdentifyOptions): Hono {
  const { db } = opts;
  const app = new Hono();
  const identify = createIdentifier(opts);

  app.put("/api/identify", async (c) => {
    if (authenticate(db, c) === null) {
      return c.json({ code: 2001, message: "Unauthorized" }, 401);
    }
    const b = await c.req.json().catch(() => null);
    if (!str(b?.document)) return c.json({ code: 2003, message: "Invalid request" }, 403);
    return c.json(await identify(b));
  });

  return app;
}

/**
 * Identification itself, shared by the plugin endpoint and by devices that only speak plain KOSync
 * (CrossPoint sends title/authors with each progress update).
 */
export function createIdentifier(opts: IdentifyOptions) {
  const { db } = opts;
  return async function identify(b: any): Promise<Record<string, unknown>> {
    const document = str(b?.document)!;

    // A name typed on the device (Tools → ShelfSync → Name this device); the plugin sends it once.
    const deviceId = str(b.device_id);
    const deviceName = str(b.device_name)?.slice(0, 60);
    if (deviceId && deviceName) {
      db.prepare(
        "INSERT INTO device_names (device_id, name) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET name = excluded.name",
      ).run(deviceId, deviceName);
    }

    const authors: string[] = Array.isArray(b.authors)
      ? b.authors.filter((a: unknown) => typeof a === "string" && a.trim())
      : str(b.authors)
        ? [str(b.authors)!]
        : [];
    const title = str(b.title);
    // Candidate UUIDs: the plugin's best guess first, then any others from the OPF.
    const candidates: string[] = [
      ...new Set(
        [b.calibre_uuid, ...(Array.isArray(b.uuids) ? b.uuids : [])]
          .map(str)
          .filter((u): u is string => u !== null),
      ),
    ];
    let uuid = candidates[0] ?? null;
    const isbn = str(b.isbn);
    const now = Math.floor(Date.now() / 1000);

    // Resolve against Calibre: UUID first, then title+author within Calibre only.
    let book: CalibreBook | null = null;
    let method: string | null = null;
    let calibreError: string | null = null;
    if (opts.calibre) {
      try {
        for (const u of candidates) {
          if ((book = opts.calibre.byUuid(u))) {
            method = "calibre-uuid";
            uuid = u; // record the one Calibre actually knows
            break;
          }
        }
        if (book) {
          /* matched by uuid */
        } else if (title && (book = opts.calibre.byTitleAuthor(title, authors))) method = "calibre-title";
      } catch (e) {
        calibreError = String(e instanceof Error ? e.message : e);
        console.error("calibre lookup failed:", calibreError);
      }
    }

    db.prepare(
      `INSERT INTO documents (document, calibre_uuid, calibre_book_id, calibre_method, title, authors, isbn, filename, first_seen, last_seen)
       VALUES (@document, @uuid, @bookId, @method, @title, @authors, @isbn, @filename, @now, @now)
       ON CONFLICT (document) DO UPDATE SET
         calibre_uuid = COALESCE(excluded.calibre_uuid, calibre_uuid),
         calibre_book_id = excluded.calibre_book_id,
         calibre_method = excluded.calibre_method,
         title = COALESCE(excluded.title, title),
         authors = COALESCE(excluded.authors, authors),
         isbn = COALESCE(excluded.isbn, isbn),
         filename = COALESCE(excluded.filename, filename),
         last_seen = excluded.last_seen`,
    ).run({
      document,
      uuid,
      bookId: book?.id ?? null,
      method,
      title,
      authors: authors.join(", ") || null,
      isbn,
      filename: str(b.filename),
      now,
    });

    if (!book) {
      return {
        status: "unmatched",
        message: calibreError
          ? `Calibre lookup failed: ${calibreError}`
          : "Not found in Calibre — will need a manual link",
      };
    }

    let identifiers: Record<string, string> = {};
    try {
      identifiers = opts.calibre!.identifiers(book.id);
    } catch (e) {
      console.error("calibre identifiers failed:", e);
    }
    const own = hardcoverHints(identifiers);
    let hints: Hints = { ...own, isbn: own.isbn ?? isbn ?? undefined };
    // Calibre has no Hardcover id of its own: use the library-wide matcher's stored answer, if any.
    if (!own.hardcover_book_id && !own.hardcover_edition_id) {
      const stored = storedMatch(db, book.id);
      if (stored) hints = { ...hints, ...stored };
    }
    const calibreInfo = { id: book.id, title: book.title, authors: book.authors };

    // Link to Hardcover (when configured). Never fuzzy-matches; unresolved -> Unmatched list.
    if (opts.hardcover) {
      const link = await linkSource({ db, hc: opts.hardcover }, "koreader", document, hints, {
        title: book.title, // Calibre's title/authors are cleaner than what KOReader reports
        authors: book.authors,
      });
      return {
        status: link.status === "linked" ? "linked" : "calibre-matched",
        method,
        message: link.status === "linked" ? link.message : `Calibre: ${book.title}\n(${link.message})`,
        calibre: calibreInfo,
        hints,
        hardcover: link,
      };
    }
    return {
      status: "calibre-matched",
      method,
      message: `Calibre: ${book.title}`,
      calibre: calibreInfo,
      hints,
    };
  };
}
