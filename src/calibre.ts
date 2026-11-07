import Database from "better-sqlite3";

export interface CalibreBook {
  id: number;
  title: string;
  uuid: string;
  authors: string[];
}

export interface Calibre {
  byUuid(uuid: string): CalibreBook | null;
  byTitleAuthor(title: string, authors: string[]): CalibreBook | null;
  identifiers(bookId: number): Record<string, string>;
  /** Every book with its authors and identifiers, in one read (for the library-wide matcher). */
  listBooks(): (CalibreBook & { identifiers: Record<string, string> })[];
}

export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘`]/g, "") // "It's" and "Its" are the same title
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const tokens = (s: string) => new Set(normalize(s).split(" ").filter(Boolean));

/** Last whitespace-separated word of a name, normalized ("Ursula K. Le Guin" -> "guin"). */
export function surname(name: string): string {
  const n = name.includes(",") ? name.split(",")[0]! : name.trim().split(/\s+/).pop()!;
  return normalize(n).split(" ").pop() ?? "";
}

/**
 * Read-only view of Calibre's metadata.db. Opens per lookup so we never hold a
 * lock while Calibre-Web is writing, and never writes.
 */
export function openCalibre(path: string): Calibre {
  const withDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const authorsOf = (db: Database.Database, bookId: number): string[] =>
    (
      db
        .prepare(
          `SELECT a.name FROM authors a
           JOIN books_authors_link l ON l.author = a.id
           WHERE l.book = ? ORDER BY l.id`,
        )
        .all(bookId) as { name: string }[]
    ).map((r) => r.name.replace(/\|/g, ",")); // Calibre stores commas as '|'

  const toBook = (db: Database.Database, r: { id: number; title: string; uuid: string }): CalibreBook => ({
    ...r,
    authors: authorsOf(db, r.id),
  });

  return {
    byUuid(uuid) {
      return withDb((db) => {
        const r = db
          .prepare("SELECT id, title, uuid FROM books WHERE lower(uuid) = lower(?)")
          .get(uuid) as { id: number; title: string; uuid: string } | undefined;
        return r ? toBook(db, r) : null;
      });
    },

    byTitleAuthor(title, authors) {
      return withDb((db) => {
        const all = db.prepare("SELECT id, title, uuid FROM books").all() as {
          id: number;
          title: string;
          uuid: string;
        }[];
        const wantTitle = normalize(title);
        const wantTokens = tokens(title);
        const wantSurnames = new Set(authors.map(surname).filter(Boolean));

        const authorOk = (b: CalibreBook) =>
          wantSurnames.size === 0 || b.authors.some((a) => wantSurnames.has(surname(a)));

        // 1) normalized exact title (+ author overlap); must be unambiguous
        const exact = all
          .filter((r) => normalize(r.title) === wantTitle)
          .map((r) => toBook(db, r))
          .filter(authorOk);
        if (exact.length === 1) return exact[0]!;
        if (exact.length > 1) return null;

        // 2) simple token match within the Calibre library only
        if (wantTokens.size === 0 || wantSurnames.size === 0) return null;
        const fuzzy = all
          .filter((r) => {
            const t = tokens(r.title);
            const shared = [...t].filter((x) => wantTokens.has(x)).length;
            const union = new Set([...t, ...wantTokens]).size;
            return union > 0 && shared / union >= 0.8;
          })
          .map((r) => toBook(db, r))
          .filter(authorOk);
        return fuzzy.length === 1 ? fuzzy[0]! : null;
      });
    },

    listBooks() {
      return withDb((db) => {
        const books = db.prepare("SELECT id, title, uuid FROM books ORDER BY id").all() as {
          id: number;
          title: string;
          uuid: string;
        }[];
        const authors = new Map<number, string[]>();
        for (const r of db
          .prepare(
            `SELECT l.book AS book, a.name AS name FROM books_authors_link l
             JOIN authors a ON a.id = l.author ORDER BY l.id`,
          )
          .all() as { book: number; name: string }[]) {
          (authors.get(r.book) ?? authors.set(r.book, []).get(r.book)!).push(r.name.replace(/\|/g, ","));
        }
        const ids = new Map<number, Record<string, string>>();
        for (const r of db.prepare("SELECT book, type, val FROM identifiers").all() as {
          book: number;
          type: string;
          val: string;
        }[]) {
          (ids.get(r.book) ?? ids.set(r.book, {}).get(r.book)!)[r.type.toLowerCase()] = r.val;
        }
        return books.map((b) => ({ ...b, authors: authors.get(b.id) ?? [], identifiers: ids.get(b.id) ?? {} }));
      });
    },

    identifiers(bookId) {
      return withDb((db) => {
        const rows = db
          .prepare("SELECT type, val FROM identifiers WHERE book = ?")
          .all(bookId) as { type: string; val: string }[];
        return Object.fromEntries(rows.map((r) => [r.type.toLowerCase(), r.val]));
      });
    },
  };
}

/** Pulls the Hardcover/ISBN hints out of a Calibre identifiers map. */
export function hardcoverHints(ids: Record<string, string>) {
  const num = (v?: string) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
  // Some plugins store a slug under "hardcover" and the numeric id under "hardcover-id",
  // so take the first identifier that is actually numeric.
  const firstNum = (...keys: string[]) => keys.map((k) => num(ids[k])).find((n) => n !== undefined);
  return {
    hardcover_book_id: firstNum("hardcover-id", "hardcover"),
    hardcover_edition_id: num(ids["hardcover-edition"]),
    isbn: ids["isbn"],
  };
}
