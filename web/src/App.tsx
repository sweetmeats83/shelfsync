import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type ActivityRow, type BookRow, type Device, type Highlight, type Hit, type Status, type Unmatched } from "./api";

type Tab = "dashboard" | "stats" | "books" | "highlights" | "devices" | "unmatched" | "guesses" | "activity";
const TABS: [Tab, string][] = [
  ["dashboard", "Dashboard"],
  ["stats", "Stats"],
  ["books", "Books"],
  ["highlights", "Highlights"],
  ["devices", "Devices"],
  ["unmatched", "Unmatched"],
  ["guesses", "Review guesses"],
  ["activity", "Activity"],
];
const STATUS: Record<number, string> = { 1: "Want to read", 2: "Reading", 3: "Read", 4: "Paused", 5: "DNF" };

const pct = (v: number | null | undefined) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const when = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toLocaleString() : "never");

function useLoad<T>(load: () => Promise<T>, deps: unknown[] = [], everyMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => load().then((d) => (setData(d), setError(null))).catch((e: Error) => setError(e.message)), deps);
  useEffect(() => {
    void reload();
    if (!everyMs) return;
    const t = setInterval(() => void reload(), everyMs);
    return () => clearInterval(t);
  }, [reload, everyMs]);
  return { data, error, reload };
}

export function App() {
  const [tab, setTab] = useState<Tab>((location.hash.slice(1) as Tab) || "dashboard");
  const go = (t: Tab) => ((location.hash = t), setTab(t));
  const status = useLoad(api.status, [], 15000);
  return (
    <div className="app">
      {status.data?.dryRun && <div className="banner">DRY_RUN is on: nothing is being written to Hardcover.</div>}
      <header>
        <h1>ShelfSync</h1>
        <nav>
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => go(t)}>
              {label}
              {t === "unmatched" && status.data?.counts.unmatched ? <span className="badge">{status.data.counts.unmatched}</span> : null}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "dashboard" && <Dashboard status={status.data} error={status.error} />}
        {tab === "stats" && <StatsPage />}
        {tab === "books" && <Books />}
        {tab === "highlights" && <Highlights />}
        {tab === "devices" && <Devices />}
        {tab === "unmatched" && <UnmatchedPage onChange={status.reload} />}
        {tab === "guesses" && <Guesses onChange={status.reload} />}
        {tab === "activity" && <Activity />}
      </main>
    </div>
  );
}

function Err({ msg }: { msg: string | null }) {
  return msg ? <p className="err">{msg}</p> : null;
}

function Dashboard({ status, error }: { status: Status | null; error: string | null }) {
  if (error) return <Err msg={error} />;
  if (!status) return <p>Loading…</p>;
  const abs = status.abs;
  return (
    <>
    <NowReading />
    <div className="cards">
      <Card title="Hardcover">{status.hardcoverUser ? `Connected as ${status.hardcoverUser}` : "Not connected"}</Card>
      <Card title="Mode">{status.dryRun ? "Dry run (no writes)" : "Live (writes to Hardcover)"}</Card>
      <Card title="Audiobookshelf">
        {!abs.configured ? "Not configured" : abs.ok === null ? "Waiting for first poll" : abs.ok ? "Connected" : `Error: ${abs.error}`}
        <small>Last poll: {when(abs.lastPollAt)}</small>
      </Card>
      <Card title="Books linked">{status.counts.books}<small>{status.counts.locked} already Read (locked)</small></Card>
      <Card title="Need attention">{status.counts.unmatched} unmatched<small>{status.counts.guesses} title guesses to review</small></Card>
    </div>
    </>
  );
}

/** Hardcover pages are /books/<slug>; until the slug is cached, fall back to a search. */
const hcUrl = (b: BookRow) =>
  b.slug ? `https://hardcover.app/books/${b.slug}` : `https://hardcover.app/search?q=${encodeURIComponent(`${b.title} ${b.author ?? ""}`.trim())}`;

const best = (b: BookRow) => Math.max(0, ...b.sources.map((s) => (s.finished ? 1 : s.pct ?? 0)));
const lastActive = (b: BookRow) => Math.max(0, ...b.sources.map((s) => s.at ?? 0));

function Cover({ book, className }: { book: BookRow; className?: string }) {
  const initials = book.title.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return book.coverUrl ? (
    <img className={className} src={book.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <div className={`${className ?? ""} nocover`}>{initials}</div>
  );
}

/** Books being read right now: cover, progress ring, and which device/format is furthest. */
function NowReading() {
  const { data } = useLoad(api.books, [], 15000);
  if (!data) return null;
  const month = Date.now() / 1000 - 30 * 86400;
  const reading = data
    .filter((b) => !b.locked && best(b) > 0 && best(b) < 0.98 && lastActive(b) > month)
    .sort((a, b) => lastActive(b) - lastActive(a))
    .slice(0, 8);
  if (!reading.length) return null;
  return (
    <section className="shelf">
      <h2>Currently reading</h2>
      <div className="books">
        {reading.map((b) => {
          const p = best(b);
          const top = [...b.sources].sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0))[0];
          return (
            <a key={b.id} className="book" href={hcUrl(b)} target="_blank" rel="noreferrer">
              <div className="coverwrap">
                <Cover book={b} className="cover" />
                <div className="ring" style={{ ["--p" as string]: `${Math.round(p * 360)}deg` }}>
                  <span>{Math.round(p * 100)}%</span>
                </div>
              </div>
              <div className="meta">
                <strong>{b.title}</strong>
                <small>{b.author}</small>
                <div className="bar"><i style={{ width: `${p * 100}%` }} /></div>
                <small>{b.sources.length > 1 ? `${top?.label} leads · ` : ""}{b.sources.map((s) => `${s.label} ${pct(s.pct)}`).join(" · ")}</small>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      <div className="big">{children}</div>
    </section>
  );
}

const FORMAT_ICON: Record<string, string> = { audio: "🎧 Audiobook", ebook: "📱 Ebook", physical: "📖 Physical" };
const length = (e: { pages: number | null; audioSeconds: number | null }) =>
  e.audioSeconds ? `${(e.audioSeconds / 3600).toFixed(1)} h` : e.pages ? `${e.pages} pp` : "no length";

/** Shows the edition in use; click to choose another (e.g. the audiobook edition). */
function EditionCell({ b, onChange }: { b: BookRow; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Awaited<ReturnType<typeof api.editions>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    setOpen(!open);
    if (!open && !list) {
      try {
        setList(await api.editions(b.id));
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  };
  const pick = async (id: number) => {
    try {
      await api.setEdition(b.id, id);
      setOpen(false);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div>
      <div>{b.editionFormat ? FORMAT_ICON[b.editionFormat] : "Not checked yet"}{b.editionManual ? " (set by you)" : ""}</div>
      {b.editionLabel && <small>{b.editionLabel}</small>}
      {!b.locked && <button className="quiet" onClick={() => void toggle()}>{open ? "Close" : "Change"}</button>}
      {open && (
        <div className="editions">
          <Err msg={err} />
          {!list && !err && <small>Loading editions…</small>}
          {list?.editions.map((e) => (
            <button key={e.id} className={`edition ${e.id === list.current ? "current" : ""}`} onClick={() => void pick(e.id)}>
              {FORMAT_ICON[e.format]} · {e.label ?? "edition"} · {length(e)}
            </button>
          ))}
          {b.editionManual && <button className="quiet" onClick={() => void api.autoEdition(b.id).then(() => (setOpen(false), onChange()))}>Go back to automatic</button>}
        </div>
      )}
    </div>
  );
}

function Books() {
  const { data, error, reload } = useLoad(api.books, [], 20000);
  if (error) return <Err msg={error} />;
  if (!data) return <p>Loading…</p>;
  if (!data.length) return <p>No linked books yet. Read something in KOReader or listen in Audiobookshelf.</p>;
  return (
    <table>
      <thead>
        <tr><th>Book</th><th>Sources</th><th>Edition</th><th>Hardcover</th><th>Last push</th></tr>
      </thead>
      <tbody>
        {data.map((b) => (
          <tr key={b.id} className={b.links.some((l) => l.method === "auto-title") ? "review" : undefined}>
            <td className="titlecell">
              <Cover book={b} className="thumb" />
              <div>
                <a href={hcUrl(b)} target="_blank" rel="noreferrer">{b.title}</a>
                <small>{b.author}</small>
                {b.links.some((l) => l.method === "auto-title") && (
                  <small className="warn">⚠ Guessed from the title: check this is the right Hardcover book (fix it under Review guesses)</small>
                )}
              </div>
            </td>
            <td>{b.sources.length ? b.sources.map((s) => <div key={s.label + s.source}>{s.label} {s.finished ? "finished" : pct(s.pct)}</div>) : "–"}</td>
            <td><EditionCell b={b} onChange={reload} /></td>
            <td>{b.locked ? "Read (locked)" : b.status ? STATUS[b.status] ?? b.status : "not set"}</td>
            <td>{b.lastPushedAt ? `${pct(b.lastPushedPct)} · ${when(b.lastPushedAt)}` : b.dryPct != null ? `dry-run ${pct(b.dryPct)}` : "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Search Hardcover and pick a book to link `item` to. */
function LinkPicker({ source, sourceId, initial, onDone }: { source: string; sourceId: string; initial: string; onDone: () => void }) {
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const search = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setHits(await api.search(q));
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  };
  const pick = async (h: Hit) => {
    setBusy(true);
    try {
      await api.link(source, sourceId, h.id);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="picker">
      <form onSubmit={(e) => (e.preventDefault(), void search())}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title and author" />
        <button disabled={busy || !q.trim()}>Search Hardcover</button>
      </form>
      <Err msg={msg} />
      {hits?.length === 0 && <p>No results.</p>}
      {hits?.map((h) => (
        <div key={h.id} className="hit">
          <span>
            <strong>{h.title}</strong> {h.author && `· ${h.author}`} {h.users != null && <small>{h.users} readers</small>}
          </span>
          <button disabled={busy} onClick={() => void pick(h)}>Link</button>
        </div>
      ))}
    </div>
  );
}

function UnmatchedPage({ onChange }: { onChange: () => void }) {
  const { data, error, reload } = useLoad(api.unmatched, [], 20000);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => (setOpen(null), void reload(), onChange());
  if (error) return <Err msg={error} />;
  if (!data) return <p>Loading…</p>;
  if (!data.length) return <p>Nothing unmatched. 🎉</p>;
  return (
    <div>
      {data.map((u: Unmatched) => {
        const key = `${u.source}:${u.sourceId}`;
        return (
          <div className="row" key={key}>
            <div className="rowhead">
              <div>
                <strong>{u.title || u.filename || (u.source === "abs" ? "Audiobook (name loading…)" : u.sourceId)}</strong>
                <small>{[u.author, u.source === "abs" ? "Audiobookshelf" : "KOReader", pct(u.pct)].filter(Boolean).join(" · ")}</small>
                {u.sugId && <small>Possible match: <strong>{u.sugTitle}</strong>{u.sugAuthor ? ` · ${u.sugAuthor}` : ""}</small>}
              </div>
              <div className="actions">
                {u.sugId && (
                  <button onClick={() => void api.link(u.source, u.sourceId, u.sugId!).then(refresh)}>Link to this</button>
                )}
                <button onClick={() => setOpen(open === key ? null : key)}>{open === key ? "Close" : "Find book"}</button>
                <button className="quiet" onClick={() => void api.ignore(u.source, u.sourceId).then(refresh)}>Ignore</button>
              </div>
            </div>
            {open === key && <LinkPicker source={u.source} sourceId={u.sourceId} initial={[u.title, u.author].filter(Boolean).join(" ")} onDone={refresh} />}
          </div>
        );
      })}
    </div>
  );
}

function Guesses({ onChange }: { onChange: () => void }) {
  const { data, error, reload } = useLoad(api.books, [], 0);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => (setOpen(null), void reload(), onChange());
  if (error) return <Err msg={error} />;
  if (!data) return <p>Loading…</p>;
  const rows = data.flatMap((b: BookRow) => b.links.filter((l) => l.method === "auto-title").map((l) => ({ b, l })));
  if (!rows.length) return <p>No title guesses to review.</p>;
  return (
    <div>
      <p className="hint">These were linked by searching Hardcover on title and author. Fix any that are wrong.</p>
      {rows.map(({ b, l }) => {
        const key = `${l.source}:${l.sourceId}`;
        return (
          <div className="row" key={key}>
            <div className="rowhead">
              <div>
                <strong>{b.title}</strong>
                <small>{[b.author, l.source === "abs" ? "Audiobookshelf" : "KOReader"].filter(Boolean).join(" · ")}</small>
              </div>
              <div className="actions">
                <a href={hcUrl(b)} target="_blank" rel="noreferrer">View on Hardcover</a>
                <button onClick={() => setOpen(open === key ? null : key)}>Change</button>
                <button className="quiet" onClick={() => void api.unlink(l.source, l.sourceId).then(refresh)}>Unlink</button>
              </div>
            </div>
            {open === key && <LinkPicker source={l.source} sourceId={l.sourceId} initial={`${b.title} ${b.author ?? ""}`.trim()} onDone={refresh} />}
          </div>
        );
      })}
    </div>
  );
}

function DeviceRow({ dev, onChange }: { dev: Device; onChange: () => void }) {
  const [name, setName] = useState(dev.name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = name.trim() !== (dev.name ?? "");
  const save = async () => {
    setBusy(true);
    try {
      await api.renameDevice(dev.id, name);
      setErr(null);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="row">
      <div className="rowhead">
        <div>
          <strong>{dev.name || dev.model || "Unknown device"}</strong>
          <small>
            {dev.model && dev.name ? `${dev.model} · ` : ""}last synced {when(dev.lastSeen)} · {dev.books} book{dev.books === 1 ? "" : "s"}
          </small>
        </div>
        <form className="actions" onSubmit={(e) => (e.preventDefault(), void save())}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={dev.model ?? "Name this device"} maxLength={60} />
          <button disabled={busy || !dirty}>Save</button>
        </form>
      </div>
      <Err msg={err} />
    </div>
  );
}

function Devices() {
  const { data, error, reload } = useLoad(api.devices, [], 0);
  if (error) return <Err msg={error} />;
  if (!data) return <p>Loading…</p>;
  if (!data.length) return <p className="hint">No devices have synced yet.</p>;
  return (
    <div>
      <p className="hint">Names are only used in this web UI. To tell devices apart, check "last synced" after reading on one. Clear a name to go back to the model.</p>
      {data.map((dev) => <DeviceRow key={dev.id} dev={dev} onChange={reload} />)}
    </div>
  );
}

function HighlightCard({ h, onChange }: { h: Highlight; onChange: () => void }) {
  const [note, setNote] = useState(h.myNote ?? "");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = async () => {
    setSending(true);
    setMsg(null);
    try {
      const r = await api.sendHighlight(h.id);
      setMsg(r.dryRun ? (r.message ?? "Dry run: nothing sent.") : null);
      if (!r.dryRun) onChange();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };
  const save = async () => {
    try {
      await api.saveNote(h.id, note);
      setEditing(false);
      setErr(null);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <figure className="hl">
      <blockquote>{h.text}</blockquote>
      <figcaption>
        {h.pct != null && <strong className="loc">{(h.pct * 100).toFixed(h.pct < 0.1 ? 1 : 0)}%</strong>}
        {[h.chapter, h.ts ? new Date(h.ts * 1000).toLocaleDateString() : null].filter(Boolean).map((s) => ` · ${s}`).join("")}
      </figcaption>
      {h.note && <p className="devnote">📝 {h.note}</p>}
      {editing ? (
        <div className="noteedit">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your note on this highlight…" rows={3} autoFocus />
          <div className="actions">
            <button onClick={() => void save()}>Save</button>
            <button className="quiet" onClick={() => (setNote(h.myNote ?? ""), setEditing(false))}>Cancel</button>
          </div>
          <Err msg={err} />
        </div>
      ) : (
        <div className="hlfoot">
          {h.myNote ? <p className="mynote" onClick={() => setEditing(true)}>{h.myNote}</p> : null}
          <button className="quiet" onClick={() => setEditing(true)}>{h.myNote ? "Edit note" : "Add note"}</button>
          <button
            className={`pill ${h.hcPrivate ? "" : "public"}`}
            title="Privacy used when this is sent to Hardcover as a journal entry"
            onClick={() => void api.setPrivacy(h.id, !h.hcPrivate).then(onChange)}
          >
            {h.hcPrivate ? "Private" : "Public"}
          </button>
          {h.hcJournalId ? (
            <span className="hint">✓ Sent to Hardcover{h.hcSentAt ? ` ${new Date(h.hcSentAt * 1000).toLocaleDateString()}` : ""}</span>
          ) : (
            <button
              className="quiet"
              disabled={!h.hardcoverBookId || sending}
              title={h.hardcoverBookId ? "Add this to your Hardcover reading journal" : "Link this book to Hardcover first"}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : "Send to Hardcover"}
            </button>
          )}
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}
    </figure>
  );
}

function Highlights() {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const { data, error, reload } = useLoad(() => api.highlights(applied), [applied], 0);
  if (error) return <Err msg={error} />;
  if (!data) return <p>Loading…</p>;
  // Group by book, keeping the newest-first order of the first highlight in each group.
  const groups = new Map<string, Highlight[]>();
  for (const h of data) {
    const key = h.bookId ? `b${h.bookId}` : `d${h.document}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  return (
    <div>
      <form className="filters" onSubmit={(e) => (e.preventDefault(), setApplied(q.trim()))}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search highlights and notes" />
        <button>Search</button>
        {applied && <button type="button" className="quiet" onClick={() => (setQ(""), setApplied(""))}>Clear</button>}
      </form>
      {!data.length && (
        <p className="hint">
          {applied ? "No matches." : "No highlights yet. Highlight text in KOReader, then choose Tools → ShelfSync → Send highlights now (or just close the book)."}
        </p>
      )}
      {[...groups.values()].map((items) => {
        const first = items[0]!;
        return (
          <section className="hlbook" key={first.bookId ?? first.document}>
            <header>
              {first.coverUrl ? <img className="thumb" src={first.coverUrl} alt="" referrerPolicy="no-referrer" /> : null}
              <div>
                <strong>{first.title || "Unidentified book"}</strong>
                <small>{[first.author, `${items.length} highlight${items.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</small>
              </div>
            </header>
            {items.map((h) => <HighlightCard key={h.id} h={h} onChange={reload} />)}
          </section>
        );
      })}
    </div>
  );
}

function Activity() {
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const { data, error } = useLoad(() => api.activity(level, source), [level, source], 10000);
  const [shown, setShown] = useState<number | null>(null);
  return (
    <div>
      <div className="filters">
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {["engine", "hardcover", "abs", "koreader", "library", "admin"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <Err msg={error} />
      {data?.map((r: ActivityRow) => (
        <div key={r.id} className={`log ${r.level}`} onClick={() => setShown(shown === r.id ? null : r.id)}>
          <span className="t">{when(r.ts)}</span> <span className="src">{r.source}</span> {r.message}
          {r.payload && shown === r.id && <pre>{JSON.stringify(JSON.parse(r.payload), null, 2)}</pre>}
        </div>
      ))}
      {data?.length === 0 && <p>No activity.</p>}
    </div>
  );
}

// Stats ---------------------------------------------------------------------

const hours = (s: number) => {
  if (!s) return "0m";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const FORMAT_NAME: Record<string, string> = { audio: "Audiobook", ebook: "Ebook", physical: "Print", unknown: "Unknown" };
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleString(undefined, { month: "short" });

/** Horizontal bars, one series: the bar is the value, the text beside it gives the number. */
function BarList({ rows }: { rows: { key: string; label: ReactNode; value: number; text: string; tip?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="barlist">
      {rows.map((r) => (
        <div className="barrow" key={r.key} title={r.tip ?? r.text}>
          <div className="barlabel">{r.label}</div>
          <div className="bartrack"><i style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <div className="barval">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

/** Vertical columns over time, one series. */
function Columns({ cols }: { cols: { key: string; label: string; value: number; tip: string }[] }) {
  const max = Math.max(1, ...cols.map((c) => c.value));
  return (
    <div className="columns">
      {cols.map((c) => (
        <div className="col" key={c.key} title={c.tip}>
          <div className="colplot"><i style={{ height: `${(c.value / max) * 100}%` }} /></div>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}

function StatsPage() {
  const { data: s, error } = useLoad(api.stats, [], 60000);
  if (error) return <Err msg={error} />;
  if (!s) return <p>Loading…</p>;
  const t = s.totals;
  const formats = Object.entries(t.finishedByFormat).sort((a, b) => b[1] - a[1]);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div className="stats">
      <div className="cards">
        <Card title="Finished this year"><span className="hero">{t.finishedThisYear}</span><small>{t.finished} finished in total</small></Card>
        <Card title="Reading time"><span className="hero">{hours(t.readingSeconds)}</span><small>on KOReader devices (estimated)</small></Card>
        <Card title="Listening time"><span className="hero">{hours(t.listeningSeconds)}</span><small>{s.listeningFromAbs ? "from Audiobookshelf's history" : "since history began"}</small></Card>
        <Card title="Streak"><span className="hero">{plural(s.streak.current, "day", "days")}</span><small>longest {s.streak.longest} · {t.activeDays} days with reading</small></Card>
        <Card title="Highlights"><span className="hero">{t.highlights}</span><small>across {t.booksTracked} books tracked</small></Card>
      </div>
      <p className="hint">
        Reading time and per-device numbers count from {s.since ? new Date(s.since * 1000).toLocaleDateString() : "your next sync"}, when ShelfSync
        started keeping progress history. Reading time is estimated from how often your devices sync, so it undercounts.
      </p>

      <section>
        <h2>Finished by format</h2>
        {formats.length ? (
          <BarList rows={formats.map(([f, n]) => ({ key: f, label: FORMAT_NAME[f] ?? f, value: n, text: plural(n, "book", "books") }))} />
        ) : <p className="hint">Nothing finished yet.</p>}
      </section>

      <section>
        <h2>Books finished per month</h2>
        <Columns cols={s.months.map((m) => ({ key: m.month, label: monthLabel(m.month), value: m.finished, tip: `${m.month}: ${m.finished} finished` }))} />
      </section>

      <section>
        <h2>Time per month</h2>
        <Columns
          cols={s.months.map((m) => ({
            key: m.month,
            label: monthLabel(m.month),
            value: m.readingSeconds + m.listeningSeconds,
            tip: `${m.month}: ${hours(m.readingSeconds + m.listeningSeconds)} (reading ${hours(m.readingSeconds)}, listening ${hours(m.listeningSeconds)})`,
          }))}
        />
      </section>

      <section>
        <h2>Top authors</h2>
        {s.authors.length ? (
          <BarList
            rows={s.authors.map((a) => ({
              key: a.author,
              label: a.author,
              value: a.books,
              text: `${plural(a.books, "book", "books")}${a.finished ? ` · ${a.finished} finished` : ""}`,
              tip: `${a.author}: ${a.books} books, ${a.finished} finished, ${hours(a.seconds)}, ${a.highlights} highlights`,
            }))}
          />
        ) : <p className="hint">No books yet.</p>}
      </section>

      <section>
        <h2>Most-read books</h2>
        {s.books.length ? (
          <BarList
            rows={s.books.map((b) => ({
              key: String(b.id),
              label: <>{b.title}{b.finished ? " ✓" : ""}<small>{b.author}</small></>,
              value: b.seconds,
              text: `${hours(b.seconds)}${b.highlights ? ` · ${plural(b.highlights, "highlight", "highlights")}` : ""}`,
              tip: `${b.title}: ${hours(b.seconds)}, ${b.highlights} highlights${b.finished ? ", finished" : ""}`,
            }))}
          />
        ) : <p className="hint">No reading time recorded yet.</p>}
      </section>

      <section>
        <h2>Devices</h2>
        {s.devices.length ? (
          <BarList
            rows={s.devices.map((d) => ({
              key: d.id,
              label: <>{d.name}<small>last used {when(d.lastSeen)}</small></>,
              value: d.seconds,
              text: `${hours(d.seconds)} · ${plural(d.books, "book", "books")}`,
              tip: `${d.name}: ${hours(d.seconds)}, ${d.books} books, ${Math.round(d.pctRead * 100)}% of a book's worth of progress`,
            }))}
          />
        ) : <p className="hint">No devices yet.</p>}
      </section>

      <section>
        <h2>Day of the week</h2>
        <Columns cols={s.weekdays.map((w) => ({ key: w.day, label: w.day, value: w.seconds, tip: `${w.day}: ${hours(w.seconds)}` }))} />
      </section>
    </div>
  );
}
