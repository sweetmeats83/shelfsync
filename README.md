# ShelfSync

A self-hosted server that keeps your reading progress in step across e-readers and your audiobook app, and pushes it to [Hardcover](https://hardcover.app).

- **KOReader sync server.** Speaks the KOSync protocol, so KOReader's built-in *Progress sync* works against it. CrossPoint-firmware readers (e.g. Xteink X4) work too.
- **Calibre-based identification.** Books are identified from your Calibre library (read-only, never written to), then linked to Hardcover.
- **Audiobookshelf.** Polls your Audiobookshelf server (read-only) for listening progress.
- **Hardcover updates.** Sets *Currently Reading* / *Read*, writes progress and dates, and picks the right edition (ebook vs audiobook) so Hardcover's format stats are correct.
- **Highlights and notes.** Stores KOReader (and CrossPoint) highlights with their location, lets you add notes, and sends the ones you pick to your Hardcover reading journal.
- **Web UI.** Dashboard with covers, books, highlights, devices, unmatched items, and an activity log.

> **Status:** built for one person's setup and used there. Some Hardcover API shapes were taken from other clients' source rather than official docs (see [Known limits](#known-limits)). Start in dry-run mode.

## Requirements and limits

- **One person per instance.** ShelfSync serves a single reader with a single Hardcover account. Progress, links and highlights are not separated per user, so two people sharing one instance would get mixed together. If several people want it, run one instance each (separate container, `.env` and data volume). They can all mount the same Calibre library read-only.
- **A Calibre library is needed to link KOReader books.** The plugin identifies a book through Calibre; without a library, KOReader books show up as unmatched and have to be linked by hand in the web UI. Audiobookshelf-only books don't need Calibre.
- **A Hardcover account and API token are required.** Without one, nothing can be pushed.
- You build the Docker image yourself (`docker compose up -d --build`); there is no published image yet.

## How progress is decided

Progress from every source for a book is compared and the furthest one wins. Hardcover is updated at most every `PUSH_INTERVAL_MINUTES` per book; finishing a book is pushed immediately. A book already marked *Read* on Hardcover is never touched. Only recently active Audiobookshelf items are synced, so your listening history isn't dumped onto Hardcover.

## Quick start

You need Docker with Compose, a Hardcover API token, and (optionally) a Calibre library and an Audiobookshelf server.

```bash
git clone https://github.com/sweetmeats83/shelfsync.git
cd shelfsync
cp .env.example .env
# edit .env: CALIBRE_LIBRARY, HARDCOVER_TOKEN, ABS_URL, ABS_TOKEN, ADMIN_PASSWORD
docker compose up -d --build
```

Then open `http://<host>:<port>/` and log in with any username and your `ADMIN_PASSWORD`.

**Start with `DRY_RUN=true` (the default).** In dry-run nothing is written to Hardcover; the Activity tab shows exactly what *would* be sent. When you're happy, set `DRY_RUN=false` and restart.

### Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALIBRE_LIBRARY` | (required) | Host folder containing `metadata.db`; mounted read-only |
| `HARDCOVER_TOKEN` | | Hardcover API token (needs write permission to push progress) |
| `ABS_URL`, `ABS_TOKEN` | | Audiobookshelf address and API token; leave empty to disable |
| `ABS_POLL_MINUTES` | `5` | How often Audiobookshelf is polled |
| `ABS_MAX_AGE_DAYS` | `3` | Ignore Audiobookshelf items not updated within this many days |
| `PUSH_INTERVAL_MINUTES` | `10` | Minimum gap between progress pushes for one book |
| `ADMIN_PASSWORD` | | Password for the web UI; the UI is disabled if empty |
| `REGISTRATION_DISABLED` | `false` | Set `true` once your devices have registered |
| `DRY_RUN` | `true` | `false` to really write to Hardcover |
| `PORT` | `8080` | Port to listen on |
| `TZ` | `America/Chicago` | Time zone used for read dates |
| `LIBRARY_MATCH` | `true` | Match the whole Calibre library to Hardcover in the background |

Keep tokens in `.env`; it is git-ignored. Put the server behind HTTPS (e.g. a reverse proxy) if it is reachable outside your network.

## Connecting readers

### KOReader (plugin recommended)

1. In KOReader: *Progress sync → Custom sync server*, enter your ShelfSync URL, then register/log in. All devices use the same account.
2. Copy the `shelfsync.koplugin` folder into KOReader's `plugins/` directory and restart KOReader.
3. With a book open: *Tools → ShelfSync*. The plugin tells the server which book you're reading (title, author, ISBN, Calibre id), sends highlights, and lets you name the device. The menu only appears while a book is open.
4. New highlights and notes are sent about 20 seconds after you make them. If the device is offline, the plugin turns Wi-Fi on (following KOReader's *Action when Wi-Fi is off* setting) or sends them the next time Wi-Fi connects. Switch this off with *Turn on Wi-Fi to send new highlights*.

Without the plugin, progress still syncs but books are linked less reliably.

### CrossPoint firmware (e.g. Xteink X4)

In the reader's KOReader Sync settings:

- Server type **Other**, server URL = your ShelfSync URL, same username and password.
- Document matching **Binary** (so it matches KOReader's hash of the same file).
- **Send metadata** on, so ShelfSync can identify the book.
- **Sync clippings** on to send highlights.

CrossPoint syncs only when you start a sync from the reader menu. Highlights from CrossPoint have a chapter but no exact page.

### Audiobookshelf

Set `ABS_URL` and `ABS_TOKEN`. ShelfSync only reads from Audiobookshelf. Audiobooks are matched to your Calibre library by title and author first, so they share a Hardcover book with the ebook.

## Linking and editions

Matching order: Hardcover id stored in Calibre (e.g. from a Calibre Hardcover metadata plugin: `hardcover-id`, `hardcover-edition`) → ISBN → ASIN → title/author search. Every book is linked to its closest Hardcover match automatically. Matches made from the title alone are marked with a warning on the **Books** tab and listed under **Review guesses**, where you can correct them. Only a book Hardcover returns nothing for stays under **Unmatched**, to be linked by searching in the UI.

The edition recorded on Hardcover follows what you're doing: listening picks the audiobook edition, reading picks an ebook edition. You can pick an edition per book on the **Books** tab.

## Highlights and Hardcover journal

The **Highlights** tab lists everything your devices sent, with chapter/page/percent where known. Add your own note to any highlight. Each has a Private/Public toggle (private by default) and a **Send to Hardcover** button; nothing is sent unless you click it.

## Known limits

- Hardcover's API is in development. Edition lookup, audio progress (`progress_seconds`) and the reading-journal mutation are based on other clients' code and docs excerpts, not verified against official documentation. Errors appear in the Activity tab.
- The KOReader plugin and the CrossPoint behaviour were written against source code, not exhaustively tested on every device.
- Calibre-Web read status is not updated.

## Development

```bash
npm install && (cd web && npm install)
npm test              # server tests (vitest)
npm run build         # compile the server
(cd web && npm run build)   # build the web UI
```

Node 20+ (the Docker image uses Node 22). Server: TypeScript, Hono, SQLite (better-sqlite3). Web UI: React + Vite, served at `/admin/`.

## License

MIT, see [LICENSE](LICENSE).
