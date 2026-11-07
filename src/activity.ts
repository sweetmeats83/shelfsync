import type { DB } from "./db.js";

export type Level = "info" | "warn" | "error";

/** Append to the activity log the web UI shows. Never throws. */
export function logActivity(
  db: DB,
  e: { level?: Level; source?: string; bookId?: number | null; message: string; payload?: unknown },
): void {
  try {
    db.prepare(
      "INSERT INTO activity (ts, level, source, book_id, message, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      Math.floor(Date.now() / 1000),
      e.level ?? "info",
      e.source ?? null,
      e.bookId ?? null,
      e.message,
      e.payload === undefined ? null : JSON.stringify(e.payload),
    );
  } catch (err) {
    console.error("activity log failed", err);
  }
  console.log(`[${e.level ?? "info"}] ${e.source ?? "-"}: ${e.message}`);
}
