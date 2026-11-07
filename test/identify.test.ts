import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { kosyncRoutes } from "../src/kosync.js";
import { identifyRoutes } from "../src/identify.js";
import { openCalibre, normalize, hardcoverHints } from "../src/calibre.js";

const KEY = "5f4dcc3b5aa765d61d8327deb882cf99";
const auth = { "x-auth-user": "nick", "x-auth-key": KEY, "content-type": "application/json" };

function makeCalibre(): string {
  const path = join(mkdtempSync(join(tmpdir(), "cal-")), "metadata.db");
  const d = new Database(path);
  d.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, uuid TEXT, path TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
    CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
    INSERT INTO authors VALUES (1,'Ursula K. Le Guin'),(2,'Andy Weir'),(3,'Brandon Sanderson');
    INSERT INTO books VALUES (1,'The Left Hand of Darkness','uuid-1','a'),
      (2,'Project Hail Mary','UUID-2','b'),(3,'Mistborn: The Final Empire','uuid-3','c'),
      (4,'Dune','uuid-4','d'),(5,'Dune','uuid-5','e');
    INSERT INTO books_authors_link VALUES (1,1,1),(2,2,2),(3,3,3),(4,4,3),(5,5,2);
    INSERT INTO identifiers VALUES (1,2,'hardcover','12345'),(2,2,'isbn','9780593135204'),(3,2,'hardcover-edition','777');
  `);
  d.close();
  return path;
}

describe("identify device names", () => {
  it("stores a device name sent by the plugin", async () => {
    const db = openDb(":memory:");
    const app = new Hono()
      .route("/", kosyncRoutes({ db, registrationDisabled: false }))
      .route("/", identifyRoutes({ db, calibre: null }));
    await app.request("/users/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "nick", password: KEY }) });
    const res = await app.request("/api/identify", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ document: "d1", title: "T", device_id: "dev-a", device_name: "  Living-room Kobo " }),
    });
    expect(res.status).toBeLessThan(300);
    expect(db.prepare("SELECT name FROM device_names WHERE device_id = 'dev-a'").get()).toEqual({ name: "Living-room Kobo" });
  });
});

describe("identify", () => {
  let app: Hono;
  const identify = (body: object) =>
    app.request("/api/identify", { method: "PUT", headers: auth, body: JSON.stringify(body) });

  beforeAll(async () => {
    const db = openDb(":memory:");
    app = new Hono()
      .route("/", kosyncRoutes({ db, registrationDisabled: false }))
      .route("/", identifyRoutes({ db, calibre: openCalibre(makeCalibre()) }));
    await app.request("/users/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nick", password: KEY }),
    });
  });

  it("requires auth", async () => {
    const r = await app.request("/api/identify", { method: "PUT", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("matches by UUID (case-insensitive) and returns hardcover hints", async () => {
    const j = await (await identify({ document: "h1", calibre_uuid: "uuid-2" })).json();
    expect(j.status).toBe("calibre-matched");
    expect(j.method).toBe("calibre-uuid");
    expect(j.hints).toEqual({ hardcover_book_id: 12345, hardcover_edition_id: 777, isbn: "9780593135204" });
  });

  it("tries every candidate UUID (EPUB's uuid_id first, Calibre's id second)", async () => {
    const j = await (
      await identify({ document: "h1b", calibre_uuid: "not-in-calibre", uuids: ["not-in-calibre", "uuid-2"] })
    ).json();
    expect(j.method).toBe("calibre-uuid");
    expect(j.calibre.id).toBe(2);
  });

  it("falls back to title + author within Calibre", async () => {
    const j = await (
      await identify({ document: "h2", title: "Mistborn: The Final Empire", authors: ["Brandon Sanderson"] })
    ).json();
    expect(j.method).toBe("calibre-title");
    expect(j.calibre.id).toBe(3);
  });

  it("tolerates punctuation/case/subtitle-ish differences", async () => {
    const j = await (
      await identify({ document: "h3", title: "mistborn the final empire", authors: "Sanderson, Brandon" })
    ).json();
    expect(j.status).toBe("calibre-matched");
  });

  it("refuses ambiguous titles unless the author disambiguates", async () => {
    const ok = await (await identify({ document: "h4", title: "Dune", authors: ["Brandon Sanderson"] })).json();
    expect(ok.calibre.id).toBe(4);
    // two 'Dune' books, no author given -> exact match list has 2 -> unmatched
    const amb = await (await identify({ document: "h5", title: "Dune", authors: [] })).json();
    expect(amb.status).toBe("unmatched");
  });

  it("is unmatched when Calibre has nothing", async () => {
    const j = await (await identify({ document: "h6", title: "Nonexistent Book", authors: ["Nobody"] })).json();
    expect(j.status).toBe("unmatched");
  });

  it("rejects a body with no document", async () => {
    expect((await identify({ title: "x" })).status).toBe(403);
  });
});

describe("hardcoverHints", () => {
  it("skips a slug under 'hardcover' and uses the numeric 'hardcover-id'", () => {
    expect(
      hardcoverHints({ hardcover: "rebecca", "hardcover-id": "263530", "hardcover-edition": "31879493", isbn: "9780316323703" }),
    ).toEqual({ hardcover_book_id: 263530, hardcover_edition_id: 31879493, isbn: "9780316323703" });
  });
  it("accepts a numeric 'hardcover' identifier", () => {
    expect(hardcoverHints({ hardcover: "12345" }).hardcover_book_id).toBe(12345);
  });
});

describe("normalize", () => {
  it("strips accents and punctuation", () => {
    expect(normalize("Café — Déjà Vu!")).toBe("cafe deja vu");
  });
});
