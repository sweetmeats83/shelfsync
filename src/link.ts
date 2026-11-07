/**
 * Temporary manual linker until the web UI exists.
 *   node dist/link.js list                          # recent KOReader documents + link state
 *   node dist/link.js search "rebecca du maurier"   # find Hardcover book ids (suggestions only)
 *   node dist/link.js <N|document-hash> <book>      # <book> = id, hardcover.app/books/... URL, or slug
 * (N = row number from `list`.)
 */
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { HardcoverClient, parseBookRef } from "./hardcover.js";
import { manualLink } from "./identification.js";

const config = loadConfig();
const [a, ...rest] = process.argv.slice(2);

function needHardcover(): HardcoverClient {
  if (!config.hardcoverToken) {
    console.error("HARDCOVER_TOKEN is not set");
    process.exit(1);
  }
  return new HardcoverClient({ token: config.hardcoverToken });
}

if (a === "search") {
  const q = rest.join(" ").trim();
  if (!q) {
    console.error('usage: link.js search "title author"');
    process.exit(1);
  }
  const results = await needHardcover().search(q);
  if (!results.length) console.log("No results.");
  results.forEach((r) => console.log(`id ${r.id}  ${r.title} — ${r.author ?? "?"}${r.users ? `  (${r.users} readers)` : ""}`));
  process.exit(0);
}

const db = openDb(config.databasePath);
const docs = db
  .prepare(
    `SELECT d.document, d.title, d.authors, b.hardcover_book_id AS hid
     FROM documents d
     LEFT JOIN links l ON l.source = 'koreader' AND l.source_id = d.document
     LEFT JOIN books b ON b.id = l.book_id
     ORDER BY d.last_seen DESC LIMIT 50`,
  )
  .all() as { document: string; title: string | null; authors: string | null; hid: number | null }[];

if (!a || a === "list") {
  docs.forEach((d, i) =>
    console.log(`${i + 1}. ${d.title ?? "(no title)"} — ${d.authors ?? "?"}  [${d.document}]  ${d.hid ? `→ Hardcover #${d.hid}` : "UNLINKED"}`),
  );
  process.exit(0);
}

const ref = rest[0] ? parseBookRef(rest[0]) : null;
if (!ref) {
  console.error("usage: link.js list | search <text> | <N|document-hash> <id|url|slug>");
  process.exit(1);
}
const document = /^\d{1,3}$/.test(a) ? docs[Number(a) - 1]?.document : a;
if (!document) {
  console.error(`No document ${a}. Run: link.js list`);
  process.exit(1);
}

const hc = needHardcover();
let bookId: number;
if ("id" in ref) {
  bookId = ref.id;
} else {
  const found = await hc.bookBySlug(ref.slug);
  if (!found) {
    console.error(`No Hardcover book with slug "${ref.slug}". Try: link.js search "<title>"`);
    process.exit(1);
  }
  console.log(`Found: ${found.title} — ${found.author ?? "?"} (id ${found.id})`);
  bookId = found.id;
}
const res = await manualLink({ db, hc }, "koreader", document, bookId);
console.log(res.message);
process.exit(res.status === "linked" ? 0 : 1);
