import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { absStatus } from "./abs.js";
import { logActivity } from "./activity.js";
import type { DB } from "./db.js";
import type { HardcoverApi } from "./hardcover.js";
import { manualLink } from "./identification.js";
import { computeStats } from "./stats.js";
export interface AdminDeps {
  db: DB;
  password: string;
  hardcover: HardcoverApi | null;
  dryRun: boolean;
  absConfigured: boolean;
  getHcUser: () => string | null;
  /** Owner's time zone, for per-day and per-month stats. */
  tz?: string;
  /** Looks up cover and page slug; fetched lazily and cached in the books table. */
  display?: (hardcoverBookId: number) => Promise<{ cover: string | null; slug: string | null }>;
  /** Re-run the progress engine for a source item after its link changed. */
  notify: (source: "koreader" | "abs", sourceId: string) => void;
  /** Writes a journal entry to Hardcover (honors DRY_RUN). privacy: 1 public, 3 private. */
  sendJournal?: (bookId: number, entry: string, privacySettingId: number) => Promise<{ dryRun: true } | { dryRun: false; id: number }>;
}

/** Entry text sent to Hardcover: the quote, where it is in the book, then your own note. */
export function journalEntry(h: { text: string; chapter?: string | null; page?: number | null; pct?: number | null; my_note?: string | null }): string {
  const where = [h.chapter, h.page ? `p. ${h.page}` : null, h.pct != null ? `${Math.round(h.pct * 100)}%` : null].filter(Boolean).join(", ");
  return [`“${h.text.trim()}”`, where ? `— ${where}` : "", h.my_note?.trim() ? `\n${h.my_note.trim()}` : ""].filter(Boolean).join("\n");
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const SOURCES = new Set(["koreader", "abs"]);

/** Basic auth: any username, password = ADMIN_PASSWORD. */
export function adminAuth(password: string) {
  const want = sha(password);
  return basicAuth({ verifyUser: (_u, p) => timingSafeEqual(sha(p), want), realm: "ShelfSync" });
}

/** JSON API for the web UI, all behind Basic auth. */
export function adminApi(d: AdminDeps): Hono {
  const app = new Hono();
  const sendingNow = new Set<number>(); // highlights with a Hardcover journal write in flight
  app.use("*", adminAuth(d.password));

  app.get("/status", (c) => {
    const n = (sql: string) => (d.db.prepare(sql).get() as { n: number }).n;
    return c.json({
      dryRun: d.dryRun,
      hardcoverUser: d.getHcUser(),
      abs: { configured: d.absConfigured, ...absStatus },
      counts: {
        books: n("SELECT COUNT(*) n FROM books"),
        locked: n("SELECT COUNT(*) n FROM books WHERE locked_finished = 1"),
        guesses: n("SELECT COUNT(*) n FROM links WHERE method = 'auto-title'"),
        unmatched: unmatchedRows(d.db).length,
      },
    });
  });

  // Covers are filled in the background (a few per request, each book tried once per hour) so the page never waits on Hardcover.
  const coverTried = new Map<number, number>();
  let coverBusy = false;
  async function fillCovers(rows: { id: number; hardcover_book_id: number; cover_url: string | null; slug: string | null }[]) {
    if (!d.display || coverBusy) return;
    const now = Date.now();
    const todo = rows.filter((r) => (!r.cover_url || !r.slug) && now - (coverTried.get(r.id) ?? 0) > 3600_000).slice(0, 6);
    if (!todo.length) return;
    coverBusy = true;
    try {
      for (const r of todo) {
        coverTried.set(r.id, now);
        try {
          const info = await d.display(r.hardcover_book_id);
          d.db
            .prepare("UPDATE books SET cover_url = COALESCE(?, cover_url), slug = COALESCE(?, slug) WHERE id = ?")
            .run(info.cover, info.slug, r.id);
        } catch {
          /* rate limit etc.: retried in an hour */
        }
      }
    } finally {
      coverBusy = false;
    }
  }

  app.get("/books", (c) => {
    const books = d.db.prepare("SELECT * FROM books ORDER BY id DESC LIMIT 500").all() as any[];
    void fillCovers(books);
    const links = d.db.prepare("SELECT source, source_id, book_id, method FROM links").all() as any[];
    const kos = d.db
      .prepare(
        `SELECT p.document, p.device_id, COALESCE(n.name, p.device) AS device, p.percentage, p.updated_at
         FROM progress p LEFT JOIN device_names n ON n.device_id = p.device_id
         WHERE p.document IN (SELECT source_id FROM links WHERE source = 'koreader') ORDER BY p.updated_at DESC`,
      )
      .all() as any[];
    const abs = d.db.prepare("SELECT item_id, progress, is_finished, last_update FROM abs_progress").all() as any[];
    const out = books.map((b) => {
      const mine = links.filter((l) => l.book_id === b.id);
      const sources: { source: string; label: string; pct: number | null; at: number | null; finished?: boolean }[] = [];
      const seen = new Set<string>();
      for (const l of mine) {
        if (l.source === "koreader") {
          for (const p of kos.filter((k) => k.document === l.source_id)) {
            const key = `${p.document}:${p.device_id}`;
            if (seen.has(key)) continue; // newest row per device (already ordered newest first)
            seen.add(key);
            sources.push({ source: "koreader", label: p.device || "KOReader", pct: p.percentage, at: p.updated_at });
          }
        } else {
          const a = abs.find((x) => x.item_id === l.source_id);
          if (a) sources.push({ source: "abs", label: "Audiobookshelf", pct: a.progress, at: a.last_update, finished: !!a.is_finished });
        }
      }
      return {
        id: b.id,
        hardcoverBookId: b.hardcover_book_id,
        title: b.title,
        author: b.author,
        coverUrl: b.cover_url as string | null,
        slug: b.slug as string | null,
        pages: b.pages,
        audioSeconds: b.audio_seconds as number | null,
        editionId: b.hardcover_edition_id as number | null,
        editionFormat: b.edition_format as string | null,
        editionLabel: b.edition_label as string | null,
        editionManual: !!b.edition_manual,
        status: b.hc_status,
        locked: !!b.locked_finished,
        lastPushedPct: b.last_pushed_pct,
        lastPushedAt: b.last_pushed_at,
        dryPct: b.dry_pct,
        finishedAt: b.finished_at,
        links: mine.map((l) => ({ source: l.source, sourceId: l.source_id, method: l.method })),
        sources,
      };
    });
    return c.json(out);
  });

  // Editions Hardcover has for this book, so you can pick the one that matches how you read it.
  app.get("/books/:id/editions", async (c) => {
    const id = Number(c.req.param("id"));
    const b = d.db.prepare("SELECT hardcover_book_id, hardcover_edition_id FROM books WHERE id = ?").get(id) as any;
    if (!b) return c.json({ error: "No such book" }, 404);
    if (!d.hardcover?.editionsForBook) return c.json({ error: "Hardcover is not configured" }, 503);
    try {
      const editions = await d.hardcover.editionsForBook(b.hardcover_book_id);
      return c.json({ current: b.hardcover_edition_id, editions });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // Your pick wins from then on: the engine stops switching editions for this book.
  app.put("/books/:id/edition", async (c) => {
    const id = Number(c.req.param("id"));
    const b = (await c.req.json().catch(() => null)) as { editionId?: unknown; auto?: unknown } | null;
    const book = d.db.prepare("SELECT hardcover_book_id, locked_finished FROM books WHERE id = ?").get(id) as any;
    if (!book) return c.json({ error: "No such book" }, 404);
    if (book.locked_finished) return c.json({ error: "This book is already marked Read on Hardcover; change its edition there." }, 409);
    if (b?.auto === true) {
      d.db.prepare("UPDATE books SET edition_manual = 0, edition_tried = NULL WHERE id = ?").run(id);
      return c.json({ ok: true });
    }
    if (!Number.isInteger(b?.editionId) || !d.hardcover?.editionsForBook) return c.json({ error: "editionId (integer) is required" }, 400);
    const e = (await d.hardcover.editionsForBook(book.hardcover_book_id)).find((x) => x.id === b!.editionId);
    if (!e) return c.json({ error: "That edition doesn't belong to this book" }, 400);
    d.db
      .prepare(
        "UPDATE books SET hardcover_edition_id = ?, pages = ?, audio_seconds = ?, edition_format = ?, edition_label = ?, edition_manual = 1 WHERE id = ?",
      )
      .run(e.id, e.pages, e.audioSeconds, e.format, e.label, id);
    logActivity(d.db, { source: "admin", bookId: id, message: `Edition set by hand: ${e.label ?? e.format}` });
    return c.json({ ok: true }); // the next progress sync uses the new edition
  });

  app.get("/devices", (c) => {
    const rows = d.db
      .prepare(
        `SELECT p.device_id AS id, p.device AS model, n.name,
                MAX(p.updated_at) AS lastSeen, COUNT(DISTINCT p.document) AS books
         FROM progress p LEFT JOIN device_names n ON n.device_id = p.device_id
         GROUP BY p.device_id ORDER BY lastSeen DESC`,
      )
      .all();
    return c.json(rows);
  });

  app.put("/devices/:id/name", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof b?.name !== "string") return c.json({ error: "name (string) is required" }, 400);
    const known = d.db.prepare("SELECT 1 FROM progress WHERE device_id = ? LIMIT 1").get(id);
    if (!known) return c.json({ error: "Unknown device" }, 404);
    const name = b.name.trim().slice(0, 60);
    if (name) d.db.prepare("INSERT INTO device_names (device_id, name) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET name = excluded.name").run(id, name);
    else d.db.prepare("DELETE FROM device_names WHERE device_id = ?").run(id); // empty name = back to the model name
    return c.json({ ok: true });
  });

  app.get("/unmatched", (c) => c.json(unmatchedRows(d.db)));

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q || !d.hardcover) return c.json([]);
    try {
      return c.json(await d.hardcover.search(q));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.post("/link", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { source?: string; sourceId?: string; hardcoverBookId?: number } | null;
    if (!b?.source || !SOURCES.has(b.source) || !b.sourceId || !Number.isInteger(b.hardcoverBookId)) {
      return c.json({ error: "source, sourceId and hardcoverBookId are required" }, 400);
    }
    if (!d.hardcover) return c.json({ error: "Hardcover is not configured" }, 503);
    const source = b.source as "koreader" | "abs";
    const res = await manualLink({ db: d.db, hc: d.hardcover }, source, b.sourceId, b.hardcoverBookId!);
    if (res.status === "linked") {
      d.db.prepare("DELETE FROM ignored WHERE source = ? AND source_id = ?").run(source, b.sourceId);
      d.notify(source, b.sourceId);
    }
    return c.json(res, res.status === "linked" ? 200 : 422);
  });

  app.post("/unlink", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { source?: string; sourceId?: string } | null;
    if (!b?.source || !SOURCES.has(b.source) || !b.sourceId) return c.json({ error: "source and sourceId are required" }, 400);
    d.db.transaction(() => {
      d.db.prepare("DELETE FROM links WHERE source = ? AND source_id = ?").run(b.source, b.sourceId);
      d.db.prepare("INSERT OR IGNORE INTO no_auto (source, source_id) VALUES (?, ?)").run(b.source, b.sourceId);
    })();
    logActivity(d.db, { source: "admin", message: `Unlinked ${b.source} ${b.sourceId} (won't be auto-guessed again)` });
    return c.json({ ok: true });
  });

  app.post("/ignore", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { source?: string; sourceId?: string } | null;
    if (!b?.source || !SOURCES.has(b.source) || !b.sourceId) return c.json({ error: "source and sourceId are required" }, 400);
    d.db.prepare("INSERT OR IGNORE INTO ignored (source, source_id, created_at) VALUES (?, ?, ?)").run(b.source, b.sourceId, Math.floor(Date.now() / 1000));
    return c.json({ ok: true });
  });

  app.get("/highlights", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const bookId = Number(c.req.query("bookId"));
    const where: string[] = [];
    const args: unknown[] = [];
    if (q) {
      where.push("(h.text LIKE ? OR h.note LIKE ? OR h.my_note LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (Number.isInteger(bookId) && bookId > 0) (where.push("b.id = ?"), args.push(bookId));
    const rows = d.db
      .prepare(
        `SELECT h.id, h.text, h.note, h.my_note AS myNote, h.chapter, h.page, h.pct, h.color, h.hl_ts AS ts, h.created_at AS createdAt,
                h.hc_private AS hcPrivate, h.hc_journal_id AS hcJournalId, h.hc_sent_at AS hcSentAt, h.document,
                b.id AS bookId, b.hardcover_book_id AS hardcoverBookId, b.slug, b.cover_url AS coverUrl,
                COALESCE(b.title, d.title) AS title, COALESCE(b.author, d.authors) AS author
         FROM highlights h
         LEFT JOIN links l ON l.source = 'koreader' AND l.source_id = h.document
         LEFT JOIN books b ON b.id = l.book_id
         LEFT JOIN documents d ON d.document = h.document
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY COALESCE(h.hl_ts, h.created_at) DESC, h.id DESC LIMIT 1000`,
      )
      .all(...args) as any[];
    return c.json(rows.map((r) => ({ ...r, hcPrivate: !!r.hcPrivate })));
  });

  app.put("/highlights/:id/note", async (c) => {
    const id = Number(c.req.param("id"));
    const b = (await c.req.json().catch(() => null)) as { note?: unknown } | null;
    if (!Number.isInteger(id) || typeof b?.note !== "string") return c.json({ error: "note (string) is required" }, 400);
    const note = b.note.trim().slice(0, 20_000) || null;
    const res = d.db.prepare("UPDATE highlights SET my_note = ? WHERE id = ?").run(note, id);
    return res.changes ? c.json({ ok: true }) : c.json({ error: "No such highlight" }, 404);
  });

  app.put("/highlights/:id/privacy", async (c) => {
    const id = Number(c.req.param("id"));
    const b = (await c.req.json().catch(() => null)) as { private?: unknown } | null;
    if (!Number.isInteger(id) || typeof b?.private !== "boolean") return c.json({ error: "private (boolean) is required" }, 400);
    const res = d.db.prepare("UPDATE highlights SET hc_private = ? WHERE id = ?").run(b.private ? 1 : 0, id);
    return res.changes ? c.json({ ok: true }) : c.json({ error: "No such highlight" }, 404);
  });

  // Only highlights you explicitly send leave ShelfSync. Private unless you toggled it public.
  app.post("/highlights/:id/send", async (c) => {
    const id = Number(c.req.param("id"));
    if (!d.sendJournal) return c.json({ error: "Hardcover is not configured" }, 503);
    const h = d.db
      .prepare(
        `SELECT h.*, b.hardcover_book_id AS hcBookId FROM highlights h
         LEFT JOIN links l ON l.source = 'koreader' AND l.source_id = h.document
         LEFT JOIN books b ON b.id = l.book_id WHERE h.id = ?`,
      )
      .get(id) as any;
    if (!h) return c.json({ error: "No such highlight" }, 404);
    if (h.hc_journal_id) return c.json({ error: "Already sent to Hardcover" }, 409);
    if (!h.hcBookId) return c.json({ error: "This book isn't linked to a Hardcover book yet" }, 400);
    const entry = journalEntry(h);
    if (sendingNow.has(id)) return c.json({ error: "Already sending this highlight" }, 409); // double-click / second tab
    sendingNow.add(id);
    try {
      const r = await d.sendJournal(h.hcBookId, entry, h.hc_private ? 3 : 1);
      if (r.dryRun) return c.json({ ok: true, dryRun: true, message: "Dry run: see Activity for the payload. Nothing was sent." });
      d.db.prepare("UPDATE highlights SET hc_journal_id = ?, hc_sent_at = ? WHERE id = ?").run(r.id, Math.floor(Date.now() / 1000), id);
      logActivity(d.db, { source: "hardcover", message: `Sent highlight to Hardcover journal (${h.hc_private ? "private" : "public"})` });
      return c.json({ ok: true, dryRun: false, journalId: r.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logActivity(d.db, { level: "error", source: "hardcover", message: `Journal send failed: ${message}` });
      return c.json({ error: message }, 502);
    } finally {
      sendingNow.delete(id);
    }
  });

  app.get("/stats", (c) => c.json(computeStats(d.db, d.tz ?? "UTC")));

  app.get("/activity", (c) => {
    const level = c.req.query("level");
    const source = c.req.query("source");
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
    const where: string[] = [];
    const args: unknown[] = [];
    if (level) (where.push("level = ?"), args.push(level));
    if (source) (where.push("source = ?"), args.push(source));
    const rows = d.db
      .prepare(
        `SELECT id, ts, level, source, book_id AS bookId, message, payload_json AS payload FROM activity
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit);
    return c.json(rows);
  });

  return app;
}

/** KOReader documents and ABS items that were seen but have no Hardcover link (and weren't ignored). */
function unmatchedRows(db: DB) {
  const docs = db
    .prepare(
      `SELECT d.document AS sourceId, d.title, d.authors AS author, d.filename, d.last_seen AS lastSeen,
              (SELECT MAX(percentage) FROM progress p WHERE p.document = d.document) AS pct,
              s.hardcover_book_id AS sugId, s.title AS sugTitle, s.author AS sugAuthor
       FROM documents d
       LEFT JOIN suggestions s ON s.source = 'koreader' AND s.source_id = d.document
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.source = 'koreader' AND l.source_id = d.document)
         AND NOT EXISTS (SELECT 1 FROM ignored i WHERE i.source = 'koreader' AND i.source_id = d.document)
       ORDER BY d.last_seen DESC LIMIT 200`,
    )
    .all() as any[];
  const abs = db
    .prepare(
      `SELECT a.item_id AS sourceId, a.title, a.author, a.progress AS pct, a.last_update AS lastSeen,
              s.hardcover_book_id AS sugId, s.title AS sugTitle, s.author AS sugAuthor
       FROM abs_progress a
       LEFT JOIN suggestions s ON s.source = 'abs' AND s.source_id = a.item_id
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.source = 'abs' AND l.source_id = a.item_id)
         AND NOT EXISTS (SELECT 1 FROM ignored i WHERE i.source = 'abs' AND i.source_id = a.item_id)
         AND (a.progress > 0 OR a.is_finished = 1)
       ORDER BY a.last_update DESC LIMIT 200`,
    )
    .all() as any[];
  return [
    ...docs.map((r) => ({ source: "koreader", ...r })),
    ...abs.map((r) => ({ source: "abs", filename: null, ...r })),
  ];
}
