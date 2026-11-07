import { normalize, surname, tokens } from "./calibre.js";

export interface SearchHit {
  id: number;
  title: string;
  author: string | null;
  users: number | null;
}

export interface Lookup {
  title: string;
  authors: string[];
}

export interface Pick {
  hit: SearchHit;
  score: number;
  runnersUp: { id: number; title: string; score: number }[];
}

const MIN_TITLE_SCORE = 0.6;
/** At or above this a guess is linked automatically; between MIN and this it's only suggested for you to accept. */
export const AUTO_MIN_SCORE = 0.9;

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((x) => b.has(x)).length;
  return shared / new Set([...a, ...b]).size;
};

/** Title without a subtitle: "Mistborn: The Final Empire" -> "Mistborn". */
const mainTitle = (t: string) => t.split(/\s*[:—–]\s*|\s+-\s+/)[0] ?? t;

export function titleScore(a: string, b: string): number {
  return Math.max(
    jaccard(tokens(a), tokens(b)),
    // equal main titles are a likely match, but "Dune" vs "Dune: Messiah" is a different book: suggest, don't auto-link
    normalize(mainTitle(a)) === normalize(mainTitle(b)) ? 0.8 : 0,
    normalize(a) === normalize(b) ? 1 : 0,
  );
}

/**
 * Best-guess pick from Hardcover search results: title must be similar enough
 * and, when we know the authors, one surname must match. Ties go to the more
 * widely read book (the canonical entry).
 */
export function pickBest(lookup: Lookup, hits: SearchHit[]): Pick | null {
  const wantSurnames = new Set(lookup.authors.map(surname).filter(Boolean));
  const scored = hits
    .map((hit) => ({ hit, score: titleScore(lookup.title, hit.title) }))
    .filter(({ hit, score }) => {
      if (score < MIN_TITLE_SCORE) return false;
      if (wantSurnames.size === 0) return true;
      return !!hit.author && wantSurnames.has(surname(hit.author));
    })
    .sort((a, b) => b.score - a.score || (b.hit.users ?? 0) - (a.hit.users ?? 0));
  const best = scored[0];
  if (!best) return null;
  return {
    hit: best.hit,
    score: Number(best.score.toFixed(2)),
    runnersUp: scored.slice(1, 4).map((s) => ({ id: s.hit.id, title: s.hit.title, score: Number(s.score.toFixed(2)) })),
  };
}
