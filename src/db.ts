import Database from "better-sqlite3";

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function addColumn(db: DB, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Idempotent. Later phases append their tables here.
function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER NOT NULL,
      document TEXT NOT NULL,
      device TEXT,
      device_id TEXT NOT NULL,
      progress TEXT,
      percentage REAL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, document, device_id)
    );
    CREATE INDEX IF NOT EXISTS progress_doc ON progress (user_id, document, updated_at);
    CREATE TABLE IF NOT EXISTS documents (
      document TEXT PRIMARY KEY,
      calibre_uuid TEXT,
      calibre_book_id INTEGER,
      calibre_method TEXT,
      title TEXT,
      authors TEXT,
      isbn TEXT,
      filename TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hardcover_book_id INTEGER NOT NULL UNIQUE,
      hardcover_edition_id INTEGER,
      title TEXT,
      author TEXT,
      pages INTEGER,
      audio_seconds INTEGER,
      hc_user_book_id INTEGER,
      hc_read_id INTEGER,
      hc_status INTEGER,
      last_pushed_pct REAL,
      last_pushed_at INTEGER,
      finished_at TEXT,
      locked_finished INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS links (
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      book_id INTEGER NOT NULL REFERENCES books(id),
      method TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source, source_id)
    );
    CREATE TABLE IF NOT EXISTS abs_progress (
      item_id TEXT PRIMARY KEY,
      progress REAL,
      current_time REAL,
      duration REAL,
      is_finished INTEGER NOT NULL DEFAULT 0,
      last_update INTEGER
    );
    CREATE TABLE IF NOT EXISTS job_locks (
      name TEXT PRIMARY KEY,
      until INTEGER NOT NULL           -- lease expiry (unix seconds); a crashed job frees itself
    );
    CREATE TABLE IF NOT EXISTS calibre_matches (
      calibre_book_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,            -- matched | nomatch | error
      hardcover_book_id INTEGER,
      hardcover_edition_id INTEGER,
      method TEXT,                     -- calibre-hardcover-id | calibre-isbn | auto-title
      score REAL,
      detail TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_names (   -- friendly names for KOReader devices, set in the web UI
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,         -- sha1(document | datetime | text): makes resends idempotent
      document TEXT NOT NULL,           -- KOSync hash; joins to links/documents for the book
      text TEXT NOT NULL,
      note TEXT,                        -- note typed on the device
      my_note TEXT,                     -- note added in ShelfSync (never overwritten by the device)
      chapter TEXT,
      page INTEGER,
      pct REAL,
      color TEXT,
      hl_time TEXT,
      hl_ts INTEGER,
      created_at INTEGER NOT NULL,
      hc_private INTEGER NOT NULL DEFAULT 1,  -- privacy to use when sent to Hardcover (1 = private)
      hc_journal_id INTEGER,
      hc_sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS suggestions (   -- middling title matches: shown in Unmatched, never linked without you
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      hardcover_book_id INTEGER NOT NULL,
      title TEXT,
      author TEXT,
      score REAL,
      PRIMARY KEY (source, source_id)
    );
    CREATE INDEX IF NOT EXISTS highlights_doc ON highlights (document, hl_ts);
    CREATE TABLE IF NOT EXISTS no_auto (   -- unlinked by hand: never title-guess this item again
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (source, source_id)
    );
    CREATE TABLE IF NOT EXISTS ignored (
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source, source_id)
    );
    CREATE TABLE IF NOT EXISTS reading_events (   -- every progress report, kept for stats (progress itself keeps only the latest)
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,             -- koreader | abs
      source_id TEXT NOT NULL,          -- KOSync document hash or ABS item id
      device_id TEXT NOT NULL,
      device TEXT,
      pct REAL,
      seconds REAL,                     -- audiobooks: position in seconds
      pulled INTEGER NOT NULL DEFAULT 0 -- 1 = device just jumped to another device's position (not reading)
    );
    CREATE INDEX IF NOT EXISTS reading_events_series ON reading_events (source, source_id, device_id, ts);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      source TEXT,
      book_id INTEGER,
      message TEXT NOT NULL,
      payload_json TEXT
    );
  `);
  // Dry-run keeps its own bookkeeping so turning DRY_RUN off later still pushes for real.
  addColumn(db, "abs_progress", "started_at", "INTEGER");
  addColumn(db, "abs_progress", "finished_at", "INTEGER");
  addColumn(db, "abs_progress", "title", "TEXT");
  addColumn(db, "abs_progress", "author", "TEXT");
  addColumn(db, "highlights", "xpointer", "TEXT");
  addColumn(db, "books", "cover_url", "TEXT");
  addColumn(db, "books", "slug", "TEXT");
  addColumn(db, "books", "edition_format", "TEXT"); // audio | ebook | physical, for the edition in use
  addColumn(db, "books", "edition_label", "TEXT"); // Hardcover's edition_format text
  addColumn(db, "books", "edition_manual", "INTEGER NOT NULL DEFAULT 0"); // 1 = picked in the UI, never auto-switched
  addColumn(db, "books", "edition_tried", "TEXT"); // format we last looked for, so a miss isn't retried every push
  addColumn(db, "books", "dry_pct", "REAL");
  addColumn(db, "books", "dry_at", "INTEGER");
  addColumn(db, "books", "dry_finished", "INTEGER NOT NULL DEFAULT 0");
}
