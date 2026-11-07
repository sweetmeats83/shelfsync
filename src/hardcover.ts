/**
 * Hardcover GraphQL client (read-only for now; writes arrive in Phase 4 and
 * must go through a single DRY_RUN-aware function).
 *
 * Query shapes marked PROVEN are copied from a working connector
 * (crosspoint-sync). Ones marked UNVERIFIED (isbn/asin/audio_seconds) are
 * checked live by `node dist/hardcover-check.js` — run it before trusting them.
 */

const ENDPOINT = "https://api.hardcover.app/v1/graphql";

export interface EditionInfo {
  id: number;
  bookId: number;
  pages: number | null;
  audioSeconds: number | null;
  title: string;
  author: string | null;
}

export type EditionKind = "audio" | "ebook" | "physical";

export interface HcEdition {
  id: number;
  label: string | null; // Hardcover's edition_format text, e.g. "Kindle Edition"
  format: EditionKind;
  pages: number | null;
  audioSeconds: number | null;
}

/**
 * Hardcover's reading_format_id is unreliable (a Kindle edition came back as 1), so the text label and
 * audio length decide. Anything not clearly audio or digital counts as physical.
 */
export function classifyEdition(e: { label: string | null; audioSeconds: number | null; readingFormatId?: number | null }): EditionKind {
  const l = (e.label ?? "").toLowerCase();
  if ((e.audioSeconds ?? 0) > 0 || /audio|cd|listen/.test(l)) return "audio";
  if (/kindle|e-?book|epub|digital|ebook|kobo|pdf/.test(l)) return "ebook";
  if (/hardcover|paperback|mass market|board|library|physical|spiral/.test(l)) return "physical";
  return e.readingFormatId === 2 ? "audio" : "physical";
}

export interface BookInfo {
  id: number;
  title: string;
  author: string | null;
  /** Default editions that have a page count, best first. */
  editions: { id: number; pages: number }[];
}

export interface UserBookInfo {
  id: number;
  statusId: number;
  edition: { id: number; pages: number | null } | null;
}

export interface HardcoverApi {
  me(): Promise<{ id: number; username: string }>;
  bookById(id: number): Promise<BookInfo | null>;
  editionById(id: number): Promise<EditionInfo | null>;
  editionByIsbn(isbn13: string): Promise<EditionInfo | null>;
  editionByAsin(asin: string): Promise<EditionInfo | null>;
  userBook(bookId: number): Promise<UserBookInfo | null>;
  editionsForBook(bookId: number): Promise<HcEdition[]>;
  /** Free-text catalog search; only used for best-guess linking and UI suggestions. */
  search(q: string): Promise<{ id: number; title: string; author: string | null; users: number | null }[]>;
}

/** "12345", "https://hardcover.app/books/rebecca", or "rebecca" -> id or slug. */
export function parseBookRef(ref: string): { id: number } | { slug: string } | null {
  const s = ref.trim();
  if (/^\d+$/.test(s)) return { id: Number(s) };
  const m = s.match(/hardcover\.app\/books\/([^/?#\s]+)/i);
  if (m) return { slug: decodeURIComponent(m[1]!) };
  return /^[a-z0-9][a-z0-9-]*$/i.test(s) ? { slug: s } : null;
}

// ---- Writes (Phase 4) -------------------------------------------------------
// Mutation shapes are copied from a working connector (crosspoint-sync). Note that
// Hardcover's read mutations REPLACE the record, so every read write carries started_at.

export interface HcState {
  userBookId: number | null;
  statusId: number | null;
  /** Reads with no finished date, newest first. */
  openReads: { id: number; startedAt: string | null; editionId: number | null }[];
}

export type WriteResult = { dryRun: true } | { dryRun: false; id: number };

export interface ReadWrite {
  /** Page-based edition: pages read. Null for audio editions, which use `seconds`. */
  pages: number | null;
  /** Audio edition: seconds listened. UNVERIFIED field (progress_seconds). */
  seconds?: number | null;
  editionId: number;
  startedAt: string; // YYYY-MM-DD
  finishedAt: string | null;
}

export interface HardcoverRW {
  readState(bookId: number): Promise<HcState>;
  /** Optional: lets the engine switch a book to the edition matching the format being read. */
  editionsForBook?(bookId: number): Promise<HcEdition[]>;
  insertUserBook(bookId: number, statusId: number): Promise<WriteResult>;
  updateUserBookStatus(userBookId: number, statusId: number): Promise<WriteResult>;
  /** `userBookId` is null only in dry-run, when the user_book would be created in the same pass. */
  insertRead(userBookId: number | null, r: ReadWrite): Promise<WriteResult>;
  updateRead(readId: number, r: ReadWrite): Promise<WriteResult>;
}

export class HardcoverError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface ClientOptions {
  token: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  /** Minimum gap between requests; Hardcover allows ~60/min. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** When true (the default, for safety) mutations are NOT sent; onDryRun gets the full GraphQL + variables. */
  dryRun?: boolean;
  onDryRun?: (name: string, query: string, variables: Record<string, unknown>) => void;
}

const BACKOFF_SECONDS = [5, 15, 30, 60, 60];
const REQUEST_TIMEOUT_MS = 30_000;

const EDITION_FIELDS = `id book_id pages audio_seconds book { id title contributions { author { name } } }`;

const firstOf = <T>(v: T | T[] | undefined | null): T | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));

export class HardcoverClient implements HardcoverApi, HardcoverRW {
  private readonly dryRun: boolean;
  private readonly onDryRun?: ClientOptions["onDryRun"];
  private readonly token: string;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly minInterval: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(o: ClientOptions) {
    this.dryRun = o.dryRun ?? true;
    this.onDryRun = o.onDryRun;
    this.token = o.token.replace(/^Bearer\s+/i, "");
    this.endpoint = o.endpoint ?? ENDPOINT;
    this.fetchFn = o.fetchFn ?? fetch;
    this.minInterval = o.minIntervalMs ?? 1100;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Serialized, rate-limited GraphQL call with backoff on 429. */
  request<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const run = () => this.execute<T>(query, variables);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minInterval - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();

      const res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ query, variables }),
        // Requests share one queue, so a stalled connection must not hold up everything behind it.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429) {
        // The limit is per minute, so back off long enough for the window to clear.
        if (attempt >= BACKOFF_SECONDS.length) throw new HardcoverError("Hardcover rate limit (429) persisted", 429);
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep((retryAfter > 0 ? retryAfter : BACKOFF_SECONDS[attempt]!) * 1000);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new HardcoverError(
          `Hardcover rejected the token (${res.status}). Check HARDCOVER_TOKEN and its permissions.`,
          res.status,
        );
      }
      if (res.status >= 500) throw new HardcoverError(`Hardcover server error ${res.status}`, res.status);

      const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
      if (body.errors?.length) throw new HardcoverError(body.errors.map((e) => e.message).join("; "), res.status);
      if (!body.data) throw new HardcoverError("Hardcover returned an empty response", res.status);
      return body.data;
    }
  }

  // PROVEN
  async me() {
    const d = await this.request(`query { me { id username } }`);
    const m = firstOf<{ id: number; username: string }>(d.me);
    if (!m) throw new HardcoverError("Hardcover did not recognize the token (no user returned)");
    return m;
  }

  // PROVEN (default editions + contributions); `audio_seconds` omitted here on purpose
  /** Cover image URL and page slug for the web UI (read-only). */
  async display(bookId: number): Promise<{ cover: string | null; slug: string | null }> {
    const d = await this.request(`query($id: Int!) { books_by_pk(id: $id) { slug image { url } } }`, { id: bookId });
    const b = d.books_by_pk;
    return {
      cover: typeof b?.image?.url === "string" && b.image.url ? b.image.url : null,
      slug: typeof b?.slug === "string" && b.slug ? b.slug : null,
    };
  }

  async bookById(id: number): Promise<BookInfo | null> {
    const d = await this.request(
      `query($id: Int!) {
         books_by_pk(id: $id) {
           id title contributions { author { name } }
           default_ebook_edition { id pages }
           default_physical_edition { id pages }
         }
       }`,
      { id },
    );
    const b = d.books_by_pk;
    if (!b) return null;
    const editions = [b.default_ebook_edition, b.default_physical_edition].filter(
      (e: any) => e && e.id != null && typeof e.pages === "number" && e.pages > 0,
    );
    return {
      id: Number(b.id),
      title: b.title,
      author: b.contributions?.[0]?.author?.name ?? null,
      editions: editions.map((e: any) => ({ id: Number(e.id), pages: Number(e.pages) })),
    };
  }

  // UNVERIFIED query shape (fields come from the Editions docs): lists a book's editions, most-used first.
  async editionsForBook(bookId: number): Promise<HcEdition[]> {
    const d = await this.request(
      `query($id: Int!) {
         editions(where: {book_id: {_eq: $id}}, order_by: {users_count: desc_nulls_last}, limit: 60) {
           id edition_format reading_format_id pages audio_seconds
         }
       }`,
      { id: bookId },
    );
    return (d.editions ?? []).map((e: any) => {
      const pages = typeof e.pages === "number" && e.pages > 0 ? e.pages : null;
      const audioSeconds = typeof e.audio_seconds === "number" && e.audio_seconds > 0 ? e.audio_seconds : null;
      const label: string | null = e.edition_format ?? null;
      return { id: Number(e.id), label, format: classifyEdition({ label, audioSeconds, readingFormatId: e.reading_format_id ?? null }), pages, audioSeconds };
    });
  }

  private toEdition(e: any): EditionInfo {
    return {
      id: Number(e.id),
      bookId: Number(e.book_id),
      pages: typeof e.pages === "number" ? e.pages : null,
      audioSeconds: typeof e.audio_seconds === "number" ? e.audio_seconds : null,
      title: e.book?.title ?? "",
      author: e.book?.contributions?.[0]?.author?.name ?? null,
    };
  }

  // UNVERIFIED: editions(id), audio_seconds
  async editionById(id: number) {
    const d = await this.request(`query($id: Int!) { editions(where: {id: {_eq: $id}}, limit: 1) { ${EDITION_FIELDS} } }`, { id });
    const e = d.editions?.[0];
    return e ? this.toEdition(e) : null;
  }

  // UNVERIFIED: isbn_13 filter
  async editionByIsbn(isbn13: string) {
    const d = await this.request(
      `query($v: String!) {
         editions(where: {isbn_13: {_eq: $v}}, order_by: {users_count: desc_nulls_last}, limit: 1) { ${EDITION_FIELDS} }
       }`,
      { v: isbn13 },
    );
    const e = d.editions?.[0];
    return e ? this.toEdition(e) : null;
  }

  // UNVERIFIED: asin filter
  async editionByAsin(asin: string) {
    const d = await this.request(
      `query($v: String!) {
         editions(where: {asin: {_eq: $v}}, order_by: {users_count: desc_nulls_last}, limit: 1) { ${EDITION_FIELDS} }
       }`,
      { v: asin },
    );
    const e = d.editions?.[0];
    return e ? this.toEdition(e) : null;
  }

  // UNVERIFIED: books.slug filter. Exact lookup, used for manual linking from a hardcover.app URL.
  async bookBySlug(slug: string): Promise<{ id: number; title: string; author: string | null } | null> {
    const d = await this.request(
      `query($slug: String!) {
         books(where: {slug: {_eq: $slug}}, limit: 1) { id title contributions { author { name } } }
       }`,
      { slug },
    );
    const b = d.books?.[0];
    return b ? { id: Number(b.id), title: b.title, author: b.contributions?.[0]?.author?.name ?? null } : null;
  }

  // UNVERIFIED: result shape (from a reference connector). Suggestions for manual linking ONLY; never auto-link.
  async search(q: string): Promise<{ id: number; title: string; author: string | null; users: number | null }[]> {
    const d = await this.request(
      `query($q: String!) { search(query: $q, query_type: "Book", per_page: 10) { results } }`,
      { q },
    );
    const raw = d.search?.results;
    const hits: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.hits) ? raw.hits : [];
    const out = [];
    for (const h of hits) {
      const doc = h?.document ?? h;
      if (doc?.id == null || typeof doc?.title !== "string") continue;
      out.push({
        id: Number(doc.id),
        title: doc.title as string,
        author: (doc.author_names?.[0] ?? doc.contributions?.[0]?.author?.name ?? null) as string | null,
        users: typeof doc.users_count === "number" ? doc.users_count : null,
      });
    }
    return out;
  }

  /** THE single place a mutation can leave this process. Honors DRY_RUN. */
  private async mutate(name: string, query: string, variables: Record<string, unknown>): Promise<any | null> {
    if (this.dryRun) {
      this.onDryRun?.(name, query, variables);
      return null;
    }
    return this.request(query, variables);
  }

  // PROVEN (reference connector's context query)
  async readState(bookId: number): Promise<HcState> {
    const d = await this.request(
      `query($bookId: Int!) {
         me {
           user_books(where: {book_id: {_eq: $bookId}}, limit: 1) {
             id status_id
             user_book_reads(where: {finished_at: {_is_null: true}}, order_by: {id: desc}, limit: 5) {
               id started_at finished_at edition { id pages }
             }
           }
         }
       }`,
      { bookId },
    );
    const ub = firstOf<any>(d.me)?.user_books?.[0];
    if (!ub) return { userBookId: null, statusId: null, openReads: [] };
    return {
      userBookId: Number(ub.id),
      statusId: typeof ub.status_id === "number" ? ub.status_id : null,
      openReads: (ub.user_book_reads ?? []).map((r: any) => ({
        id: Number(r.id),
        startedAt: r.started_at ?? null,
        editionId: r.edition?.id != null ? Number(r.edition.id) : null,
      })),
    };
  }

  // PROVEN
  async insertUserBook(bookId: number, statusId: number): Promise<WriteResult> {
    const d = await this.mutate(
      "insert_user_book",
      `mutation SetStatus($bookId: Int!, $statusId: Int!) {
         insert_user_book(object: { book_id: $bookId, status_id: $statusId }) { user_book { id } }
       }`,
      { bookId, statusId },
    );
    if (d === null) return { dryRun: true };
    const id = d.insert_user_book?.user_book?.id;
    if (id == null) throw new HardcoverError("insert_user_book not confirmed (empty response)");
    return { dryRun: false, id: Number(id) };
  }

  // PROVEN
  async updateUserBookStatus(userBookId: number, statusId: number): Promise<WriteResult> {
    const d = await this.mutate(
      "update_user_book",
      `mutation UpdStatus($id: Int!, $statusId: Int!) {
         update_user_book(id: $id, object: { status_id: $statusId }) { user_book { id } }
       }`,
      { id: userBookId, statusId },
    );
    if (d === null) return { dryRun: true };
    const id = d.update_user_book?.user_book?.id;
    if (id == null) throw new HardcoverError("update_user_book not confirmed (empty response)");
    return { dryRun: false, id: Number(id) };
  }

  // PROVEN
  async insertRead(userBookId: number | null, r: ReadWrite): Promise<WriteResult> {
    const audio = r.seconds != null;
    const d = await this.mutate(
      "insert_user_book_read",
      `mutation InsRead($id: Int!, $${audio ? "seconds" : "pages"}: Int!, $editionId: Int!, $startedAt: date!, $finishedAt: date) {
         insert_user_book_read(
           user_book_id: $id
           user_book_read: { ${audio ? "progress_seconds: $seconds" : "progress_pages: $pages"}, edition_id: $editionId, started_at: $startedAt, finished_at: $finishedAt }
         ) { error user_book_read { id } }
       }`,
      { id: userBookId, ...(audio ? { seconds: r.seconds } : { pages: r.pages }), editionId: r.editionId, startedAt: r.startedAt, finishedAt: r.finishedAt },
    );
    if (d === null) return { dryRun: true };
    if (d.insert_user_book_read?.error) throw new HardcoverError(String(d.insert_user_book_read.error));
    const id = d.insert_user_book_read?.user_book_read?.id;
    if (id == null) throw new HardcoverError("insert_user_book_read not confirmed (empty response)");
    return { dryRun: false, id: Number(id) };
  }

  // PROVEN
  async updateRead(readId: number, r: ReadWrite): Promise<WriteResult> {
    const audio = r.seconds != null;
    const d = await this.mutate(
      "update_user_book_read",
      `mutation UpdRead($id: Int!, $${audio ? "seconds" : "pages"}: Int!, $editionId: Int!, $startedAt: date!, $finishedAt: date) {
         update_user_book_read(id: $id, object: { ${audio ? "progress_seconds: $seconds" : "progress_pages: $pages"}, edition_id: $editionId, started_at: $startedAt, finished_at: $finishedAt }) {
           error user_book_read { id }
         }
       }`,
      { id: readId, ...(audio ? { seconds: r.seconds } : { pages: r.pages }), editionId: r.editionId, startedAt: r.startedAt, finishedAt: r.finishedAt },
    );
    if (d === null) return { dryRun: true };
    if (d.update_user_book_read?.error) throw new HardcoverError(String(d.update_user_book_read.error));
    const id = d.update_user_book_read?.user_book_read?.id;
    if (id == null) throw new HardcoverError("update_user_book_read not confirmed (empty response)");
    return { dryRun: false, id: Number(id) };
  }

  /**
   * UNVERIFIED against Hardcover's own docs (their docs site blocked automated reads): the mutation shape
   * comes from a community client (kristianedlund/hardcover-mcp). privacy: 1 public, 2 followers, 3 private.
   */
  async insertJournal(bookId: number, entry: string, privacySettingId: number): Promise<WriteResult> {
    const d = await this.mutate(
      "insert_reading_journal",
      `mutation InsertReadingJournal($object: ReadingJournalCreateType!) {
         insert_reading_journal(object: $object) { reading_journal { id book_id event entry privacy_setting_id } }
       }`,
      { object: { book_id: bookId, entry, event: "quote", privacy_setting_id: privacySettingId, tags: [] } },
    );
    if (d === null) return { dryRun: true };
    const id = d.insert_reading_journal?.reading_journal?.id;
    if (id == null) throw new HardcoverError("insert_reading_journal not confirmed (empty response; check your API key allows journal writes)");
    return { dryRun: false, id: Number(id) };
  }

  // PROVEN
  async userBook(bookId: number): Promise<UserBookInfo | null> {
    const d = await this.request(
      `query($bookId: Int!) {
         me { user_books(where: {book_id: {_eq: $bookId}}, limit: 1) { id status_id edition { id pages } } }
       }`,
      { bookId },
    );
    const ub = firstOf<any>(d.me)?.user_books?.[0];
    if (!ub) return null;
    return {
      id: Number(ub.id),
      statusId: Number(ub.status_id),
      edition: ub.edition ? { id: Number(ub.edition.id), pages: typeof ub.edition.pages === "number" ? ub.edition.pages : null } : null,
    };
  }
}
