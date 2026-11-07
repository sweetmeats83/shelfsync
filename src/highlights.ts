import { createHash } from "node:crypto";
import { Hono } from "hono";
import { logActivity } from "./activity.js";
import type { DB } from "./db.js";
import { authenticate } from "./kosync.js";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const MAX_PER_REQUEST = 2000;
const MAX_TEXT = 20_000;

/** KOReader stamps highlights "YYYY-MM-DD HH:MM:SS" in device-local time. Good enough for ordering. */
function toEpoch(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export const highlightKey = (document: string, datetime: string | null, text: string) =>
  createHash("sha1").update(`${document}|${datetime ?? ""}|${text}`).digest("hex");

/**
 * PUT /api/highlights — the KOReader plugin sends a book's highlights and device notes.
 * Idempotent: the same highlight sent twice is one row; an edited note/chapter is updated.
 * Notes added in ShelfSync (my_note) are never overwritten.
 */
export function highlightRoutes(opts: { db: DB }): Hono {
  const { db } = opts;
  const app = new Hono();

  app.put("/api/highlights", async (c) => {
    if (authenticate(db, c) === null) return c.json({ code: 2001, message: "Unauthorized" }, 401);
    const b = await c.req.json().catch(() => null);
    const document = str(b?.document);
    if (!document || !Array.isArray(b?.highlights)) return c.json({ code: 2003, message: "Invalid request" }, 403);
    const total = Number(b.page_total) > 0 ? Number(b.page_total) : null;

    const find = db.prepare("SELECT id FROM highlights WHERE key = ?");
    const upsert = db.prepare(
      `INSERT INTO highlights (key, document, text, note, chapter, page, pct, xpointer, color, hl_time, hl_ts, created_at)
       VALUES (@key, @document, @text, @note, @chapter, @page, @pct, @xpointer, @color, @hl_time, @hl_ts, @now)
       ON CONFLICT (key) DO UPDATE SET note = excluded.note, chapter = excluded.chapter,
         page = COALESCE(excluded.page, highlights.page), pct = COALESCE(excluded.pct, highlights.pct),
         xpointer = COALESCE(excluded.xpointer, highlights.xpointer), color = excluded.color`,
    );
    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    let seen = 0;
    db.transaction(() => {
      for (const h of b.highlights.slice(0, MAX_PER_REQUEST)) {
        const text = str(h?.text)?.slice(0, MAX_TEXT);
        if (!text) continue;
        const hlTime = str(h?.datetime);
        const page = Number.isFinite(Number(h?.page)) && Number(h.page) > 0 ? Math.floor(Number(h.page)) : null;
        const key = highlightKey(document, hlTime, text);
        if (!find.get(key)) added++;
        seen++;
        upsert.run({
          key,
          document,
          text,
          note: str(h?.note)?.slice(0, MAX_TEXT) ?? null,
          chapter: str(h?.chapter)?.slice(0, 500) ?? null,
          page,
          // Prefer the plugin's text-position percentage; fall back to page / page count.
          pct:
            h?.pct != null && h.pct !== "" && Number.isFinite(Number(h.pct)) && Number(h.pct) >= 0 && Number(h.pct) <= 1
              ? Number(h.pct)
              : page && total
                ? Math.min(1, page / total)
                : null,
          xpointer: str(h?.xpointer)?.slice(0, 1000) ?? null,
          color: str(h?.color),
          hl_time: hlTime,
          hl_ts: toEpoch(hlTime),
          now,
        });
      }
    })();
    if (added) logActivity(db, { source: "koreader", message: `Stored ${added} new highlight(s) (${seen} received)` });
    return c.json({ stored: seen, added, message: added ? `Saved ${added} new highlight(s) to ShelfSync` : "Highlights already up to date" });
  });

  // CrossPoint readers ("Sync clippings") use their own small API, not KOSync. We only receive:
  // the probe and pulls answer "nothing to download", uploads are stored as highlights, and
  // tombstones remove a highlight that was never sent to Hardcover.
  app.get("/api/v1/clippings/:document", (c) => {
    if (authenticate(db, c) === null) return c.json({ code: 2001, message: "Unauthorized" }, 401);
    const cursor = Math.max(0, Math.floor(Number(c.req.query("cursor")) || 0));
    return c.json({ sync_version: 2, cursor, more: false, items: [] });
  });

  app.put("/api/v1/clippings/:document", async (c) => {
    if (authenticate(db, c) === null) return c.json({ code: 2001, message: "Unauthorized" }, 401);
    const document = c.req.param("document");
    const b = await c.req.json().catch(() => null);
    if (!document || !Array.isArray(b?.items)) return c.json({ code: 2003, message: "Invalid request" }, 403);
    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    db.transaction(() => {
      for (const it of b.items.slice(0, MAX_PER_REQUEST)) {
        const id = str(it?.id);
        if (!id) continue;
        const key = `cp:${document}:${id}`;
        if (Number(it?.deleted) === 1) {
          db.prepare("DELETE FROM highlights WHERE key = ? AND hc_journal_id IS NULL").run(key);
          continue;
        }
        const text = str(it?.text)?.slice(0, MAX_TEXT);
        if (!text) continue;
        // created_at may be seconds or milliseconds.
        const raw = Number(it?.created_at);
        const ts = Number.isFinite(raw) && raw > 0 ? Math.floor(raw > 1e11 ? raw / 1000 : raw) : null;
        const spine = it?.spine == null || it.spine === "" ? NaN : Number(it.spine);
        // Pages in a clipping are relative to its chapter, so there's no reliable book position: keep the chapter only.
        const chapter = str(it?.chapter)?.slice(0, 500) ?? (Number.isFinite(spine) ? `Section ${spine + 1}` : null);
        if (!db.prepare("SELECT 1 FROM highlights WHERE key = ?").get(key)) added++;
        db.prepare(
          `INSERT INTO highlights (key, document, text, chapter, hl_time, hl_ts, created_at)
           VALUES (@key, @document, @text, @chapter, @hl_time, @hl_ts, @now)
           ON CONFLICT (key) DO UPDATE SET text = excluded.text, chapter = excluded.chapter`,
        ).run({ key, document, text, chapter, hl_time: ts ? new Date(ts * 1000).toISOString() : null, hl_ts: ts, now });
      }
    })();
    if (added) logActivity(db, { source: "koreader", message: `Stored ${added} new highlight(s) from a CrossPoint reader` });
    return c.json({ accepted: 1 });
  });

  return app;
}
