export interface Status {
  dryRun: boolean;
  hardcoverUser: string | null;
  abs: { configured: boolean; lastPollAt: number | null; ok: boolean | null; error: string | null };
  counts: { books: number; locked: number; guesses: number; unmatched: number };
}

export interface BookRow {
  id: number;
  hardcoverBookId: number;
  title: string;
  author: string | null;
  coverUrl: string | null;
  slug: string | null;
  pages: number | null;
  audioSeconds: number | null;
  editionId: number | null;
  editionFormat: "audio" | "ebook" | "physical" | null;
  editionLabel: string | null;
  editionManual: boolean;
  status: number | null;
  locked: boolean;
  lastPushedPct: number | null;
  lastPushedAt: number | null;
  dryPct: number | null;
  finishedAt: string | null;
  links: { source: "koreader" | "abs"; sourceId: string; method: string }[];
  sources: { source: string; label: string; pct: number | null; at: number | null; finished?: boolean }[];
}

export interface Unmatched {
  source: "koreader" | "abs";
  sourceId: string;
  title: string | null;
  author: string | null;
  filename: string | null;
  pct: number | null;
  lastSeen: number | null;
  /** A plausible Hardcover match that wasn't certain enough to link on its own. */
  sugId: number | null;
  sugTitle: string | null;
  sugAuthor: string | null;
}

export interface Hit {
  id: number;
  title: string;
  author: string | null;
  users: number | null;
}

export interface ActivityRow {
  id: number;
  ts: number;
  level: "info" | "warn" | "error";
  source: string | null;
  bookId: number | null;
  message: string;
  payload: string | null;
}

export interface Device {
  id: string;
  model: string | null;
  name: string | null;
  lastSeen: number;
  books: number;
}

export interface Highlight {
  id: number;
  text: string;
  note: string | null;
  myNote: string | null;
  chapter: string | null;
  page: number | null;
  pct: number | null;
  color: string | null;
  ts: number | null;
  createdAt: number;
  hcPrivate: boolean;
  hcJournalId: number | null;
  hcSentAt: number | null;
  document: string;
  bookId: number | null;
  hardcoverBookId: number | null;
  slug: string | null;
  coverUrl: string | null;
  title: string | null;
  author: string | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? `HTTP ${res.status}`);
  return data as T;
}

const post = <T,>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  status: () => call<Status>("/status"),
  books: () => call<BookRow[]>("/books"),
  unmatched: () => call<Unmatched[]>("/unmatched"),
  search: (q: string) => call<Hit[]>(`/search?q=${encodeURIComponent(q)}`),
  link: (source: string, sourceId: string, hardcoverBookId: number) => post<{ message: string }>("/link", { source, sourceId, hardcoverBookId }),
  unlink: (source: string, sourceId: string) => post<{ ok: boolean }>("/unlink", { source, sourceId }),
  ignore: (source: string, sourceId: string) => post<{ ok: boolean }>("/ignore", { source, sourceId }),
  devices: () => call<Device[]>("/devices"),
  renameDevice: (id: string, name: string) =>
    call<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/name`, { method: "PUT", body: JSON.stringify({ name }) }),
  highlights: (q: string) => call<Highlight[]>(`/highlights${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  saveNote: (id: number, note: string) => call<{ ok: boolean }>(`/highlights/${id}/note`, { method: "PUT", body: JSON.stringify({ note }) }),
  setPrivacy: (id: number, isPrivate: boolean) =>
    call<{ ok: boolean }>(`/highlights/${id}/privacy`, { method: "PUT", body: JSON.stringify({ private: isPrivate }) }),
  editions: (bookId: number) =>
    call<{ current: number | null; editions: { id: number; label: string | null; format: "audio" | "ebook" | "physical"; pages: number | null; audioSeconds: number | null }[] }>(
      `/books/${bookId}/editions`,
    ),
  setEdition: (bookId: number, editionId: number) =>
    call<{ ok: boolean }>(`/books/${bookId}/edition`, { method: "PUT", body: JSON.stringify({ editionId }) }),
  autoEdition: (bookId: number) => call<{ ok: boolean }>(`/books/${bookId}/edition`, { method: "PUT", body: JSON.stringify({ auto: true }) }),
  sendHighlight: (id: number) =>
    call<{ ok: boolean; dryRun: boolean; message?: string }>(`/highlights/${id}/send`, { method: "POST" }),
  activity: (level: string, source: string) =>
    call<ActivityRow[]>(`/activity?limit=200${level ? `&level=${level}` : ""}${source ? `&source=${source}` : ""}`),
};
