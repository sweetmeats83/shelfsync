/**
 * Run the library-wide Hardcover matcher once, in the foreground.
 *   docker compose exec shelfsync node dist/batch.js [limit]      # limit = max books to process
 *   docker compose exec shelfsync node dist/batch.js report       # summary of stored matches
 * Reads Calibre and Hardcover; writes only ShelfSync's own database.
 */
import { openCalibre } from "./calibre.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { HardcoverClient } from "./hardcover.js";
import { matchLibrary } from "./libraryMatch.js";

const config = loadConfig();
const db = openDb(config.databasePath);
const arg = process.argv[2];

if (arg === "report") {
  console.log(db.prepare("SELECT status, method, count(*) n FROM calibre_matches GROUP BY status, method ORDER BY n DESC").all());
  console.log("Lowest-confidence guesses:");
  console.table(
    db
      .prepare(
        `SELECT calibre_book_id AS calibre, hardcover_book_id AS hardcover, score, detail FROM calibre_matches
         WHERE method = 'auto-title' ORDER BY score ASC LIMIT 15`,
      )
      .all(),
  );
  process.exit(0);
}
if (!config.hardcoverToken) {
  console.error("HARDCOVER_TOKEN is not set");
  process.exit(1);
}
const limit = arg ? Number(arg) : undefined;
const stats = await matchLibrary({ db, calibre: openCalibre(config.calibreDbPath), hc: new HardcoverClient({ token: config.hardcoverToken }) }, { limit });
console.log(stats);
process.exit(stats.aborted ? 1 : 0);
