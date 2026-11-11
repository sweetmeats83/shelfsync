import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { pollAbs } from "./abs.js";
import { adminApi, adminAuth } from "./admin.js";
import { logActivity } from "./activity.js";
import { openCalibre } from "./calibre.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { HardcoverClient } from "./hardcover.js";
import { highlightRoutes } from "./highlights.js";
import { createIdentifier, fromKosyncMetadata, identifyRoutes } from "./identify.js";
import { kosyncRoutes } from "./kosync.js";
import { matchLibrary } from "./libraryMatch.js";
import { ProgressEngine } from "./progress.js";

const config = loadConfig();
const db = openDb(config.databasePath);

const calibre = existsSync(config.calibreDbPath) ? openCalibre(config.calibreDbPath) : null;
if (!calibre) console.warn(`Calibre db not found at ${config.calibreDbPath}; identification disabled`);

let hcUser: string | null = null;

// One client for everything: it owns the rate limiter and the only path mutations take out (DRY_RUN).
const hardcover = config.hardcoverToken
  ? new HardcoverClient({
      token: config.hardcoverToken,
      dryRun: config.dryRun,
      onDryRun: (name, query, variables) =>
        logActivity(db, {
          source: "hardcover",
          message: `[dry-run] would send ${name}`,
          payload: { query: query.replace(/\s+/g, " ").trim(), variables },
        }),
    })
  : null;
if (!hardcover) console.warn("HARDCOVER_TOKEN not set; books will not be linked to Hardcover");
else {
  hardcover
    .me()
    .then((m) => {
      hcUser = m.username;
      logActivity(db, {
        source: "hardcover",
        message: `Hardcover connected as ${m.username}${config.dryRun ? " (DRY_RUN: nothing will be written)" : " (LIVE: progress will be written)"}`,
      });
    })
    .catch((e) => logActivity(db, { level: "error", source: "hardcover", message: `Hardcover check failed: ${e.message}` }));
}

// Library-wide matching: read-only toward Calibre and Hardcover; resumable; repeats daily for new books.
if (hardcover && calibre && config.libraryMatch) {
  const run = async (): Promise<void> => {
    try {
      const stats = await matchLibrary({ db, calibre, hc: hardcover });
      // Stopped by a rate limit: pick up where we left off soon instead of waiting a day.
      if (stats.retryAfterSec) setTimeout(run, stats.retryAfterSec * 1000).unref();
    } catch (e) {
      logActivity(db, { level: "error", source: "library", message: `Library match failed: ${e instanceof Error ? e.message : e}` });
    }
  };
  setTimeout(run, 10_000); // let startup finish first
  setInterval(run, 24 * 3600 * 1000).unref();
}

// Progress engine: reacts to KOSync pushes, never blocks the device's request.
const engine = hardcover ? new ProgressEngine({ db, rw: hardcover, dryRun: config.dryRun, tz: config.tz, pushIntervalSec: Math.max(1, config.pushIntervalMinutes) * 60 }) : null;

// Audiobookshelf: read-only poll; changed items go to the engine.
if (config.absUrl && config.absToken) {
  const poll = async (): Promise<void> => {
    try {
      await pollAbs({ db, url: config.absUrl, token: config.absToken, hc: hardcover, calibre, maxAgeDays: config.absMaxAgeDays, onChange: (id) => engine?.notify("abs", id) });
    } catch (e) {
      logActivity(db, { level: "error", source: "abs", message: `Audiobookshelf poll crashed: ${e instanceof Error ? e.message : e}` });
    }
  };
  setTimeout(poll, 15_000);
  setInterval(poll, Math.max(1, config.absPollMinutes) * 60_000).unref();
  logActivity(db, { source: "abs", message: `Audiobookshelf polling ${config.absUrl} every ${config.absPollMinutes} min` });
} else {
  console.warn("ABS_URL/ABS_TOKEN not set; Audiobookshelf polling disabled");
}

const app = new Hono();
app.use(logger()); // request log: method, path, status, time
const identifyDocument = createIdentifier({ db, calibre, hardcover });
app.route(
  "/",
  kosyncRoutes({
    db,
    registrationDisabled: config.registrationDisabled,
    onProgress: (_userId, document) => engine?.notifyDocument(document),
    onLookup: (document, row) => {
      const short = document.slice(0, 8);
      if (row) {
        logActivity(db, { source: "koreader", message: `Progress lookup ${short}…: sent ${Math.round(row.percentage * 100)}% (last from ${row.device})` });
        return;
      }
      // Nothing stored under this hash. If the same title exists under a different hash, the files differ.
      const me = db.prepare("SELECT title FROM documents WHERE document = ?").get(document) as { title: string | null } | undefined;
      const twin = me?.title
        ? (db
            .prepare(
              `SELECT d.document FROM documents d WHERE d.document != ? AND lower(d.title) = lower(?)
                 AND EXISTS (SELECT 1 FROM progress p WHERE p.document = d.document) LIMIT 1`,
            )
            .get(document, me.title) as { document: string } | undefined)
        : undefined;
      logActivity(db, {
        level: "warn",
        source: "koreader",
        message: twin
          ? `Progress lookup ${short}…: nothing stored, but "${me!.title}" exists under a different file hash (${twin.document.slice(0, 8)}…). The files differ, so devices won't share progress. Use the same EPUB file everywhere and Binary matching.`
          : `Progress lookup ${short}…: nothing stored for this file hash yet.`,
      });
    },
    onMetadata: (document, m) => {
      // Only for books we can't place yet, at most once an hour each.
      const seen = db.prepare("SELECT 1 FROM links WHERE source = 'koreader' AND source_id = ?").get(document);
      const doc = db.prepare("SELECT last_seen FROM documents WHERE document = ?").get(document) as { last_seen: number } | undefined;
      if (seen || (doc && doc.last_seen > Math.floor(Date.now() / 1000) - 3600)) return;
      void identifyDocument(fromKosyncMetadata(document, m))
        .then(() => engine?.notifyDocument(document))
        .catch((e) => logActivity(db, { level: "error", source: "koreader", message: `Identify from sync metadata failed: ${e instanceof Error ? e.message : e}` }));
    },
  }),
);
app.route("/", identifyRoutes({ db, calibre, hardcover }));
app.route("/", highlightRoutes({ db }));

// Web UI (Phase 6): the React app is built into ./web-dist by the Dockerfile.
if (config.adminPassword) {
  app.route(
    "/admin/api",
    adminApi({
      db,
      password: config.adminPassword,
      hardcover,
      dryRun: config.dryRun,
      absConfigured: !!(config.absUrl && config.absToken),
      getHcUser: () => hcUser,
      tz: config.tz,
      display: hardcover ? (id) => hardcover.display(id) : undefined,
      sendJournal: hardcover ? (bookId, entry, privacy) => hardcover.insertJournal(bookId, entry, privacy) : undefined,
      notify: (source, id) => engine?.notify(source, id),
    }),
  );
  app.get("/", (c) => c.redirect("/admin/"));
  app.get("/admin", (c) => c.redirect("/admin/"));
  app.use("/admin/*", adminAuth(config.adminPassword));
  app.use("/admin/*", serveStatic({ root: "./web-dist", rewriteRequestPath: (p) => p.replace(/^\/admin/, "") }));
} else {
  console.warn("ADMIN_PASSWORD not set; web UI disabled");
}

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`ShelfSync listening on :${info.port} (DRY_RUN=${config.dryRun})`);
});
