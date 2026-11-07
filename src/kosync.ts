import { Hono, type Context } from "hono";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.js";

export interface KosyncOptions {
  db: DB;
  registrationDisabled: boolean;
  /** Phase 4 hook; called after every successful progress PUT. */
  onProgress?: (userId: number, document: string) => void;
  /** Devices without a ShelfSync plugin (CrossPoint) put title/authors in the progress body; this identifies from them. */
  onMetadata?: (document: string, metadata: Record<string, unknown>, device: { id: string; name: string }) => void;
}

const err = (code: number, message: string) => ({ code, message });

function hashKey(key: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(key, salt, 32).toString("hex")}`;
}

function verifyKey(key: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(key, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Returns the user id for valid x-auth-user / x-auth-key headers, else null. */
export function authenticate(db: DB, c: Context): number | null {
  const username = c.req.header("x-auth-user");
  const key = c.req.header("x-auth-key");
  if (!username || !key) return null;
  const row = db
    .prepare("SELECT id, password_hash FROM users WHERE username = ?")
    .get(username) as { id: number; password_hash: string } | undefined;
  return row && verifyKey(key, row.password_hash) ? row.id : null;
}

export function kosyncRoutes(opts: KosyncOptions): Hono {
  const { db } = opts;
  const app = new Hono();

  const authUser = (c: Context) => authenticate(db, c);

  app.get("/healthcheck", (c) => c.json({ state: "OK" }));

  app.post("/users/create", async (c) => {
    if (opts.registrationDisabled) {
      return c.json(err(2005, "User registration is disabled."), 402);
    }
    const body = await c.req.json().catch(() => null);
    const username = body?.username;
    const password = body?.password;
    if (typeof username !== "string" || !username || typeof password !== "string" || !password) {
      return c.json(err(2003, "Invalid request"), 403);
    }
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
      return c.json(err(2002, "Username is already registered."), 402);
    }
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      username,
      hashKey(password),
    );
    return c.json({ username }, 201);
  });

  app.get("/users/auth", (c) =>
    authUser(c) === null
      ? c.json(err(2001, "Unauthorized"), 401)
      : c.json({ authorized: "OK" }),
  );

  app.put("/syncs/progress", async (c) => {
    const userId = authUser(c);
    if (userId === null) return c.json(err(2001, "Unauthorized"), 401);
    const b = await c.req.json().catch(() => null);
    if (
      !b ||
      typeof b.document !== "string" || !b.document ||
      typeof b.progress !== "string" ||
      typeof b.percentage !== "number" ||
      typeof b.device !== "string" ||
      typeof b.device_id !== "string" || !b.device_id
    ) {
      return c.json(err(2003, "Invalid request"), 403);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO progress (user_id, document, device, device_id, progress, percentage, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, document, device_id) DO UPDATE SET
         device = excluded.device, progress = excluded.progress,
         percentage = excluded.percentage, updated_at = excluded.updated_at`,
    ).run(userId, b.document, b.device, b.device_id, b.progress, b.percentage, timestamp);
    try {
      if (b.metadata && typeof b.metadata === "object") opts.onMetadata?.(b.document, b.metadata, { id: b.device_id, name: b.device });
      opts.onProgress?.(userId, b.document);
    } catch (e) {
      console.error("onProgress failed", e); // never fail a device sync because of downstream
    }
    return c.json({ document: b.document, timestamp });
  });

  app.get("/syncs/progress/:document", (c) => {
    const userId = authUser(c);
    if (userId === null) return c.json(err(2001, "Unauthorized"), 401);
    const document = c.req.param("document");
    const row = db
      .prepare(
        `SELECT document, progress, percentage, device, device_id, updated_at AS timestamp
         FROM progress WHERE user_id = ? AND document = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(userId, document);
    return c.json(row ?? {});
  });

  return app;
}
