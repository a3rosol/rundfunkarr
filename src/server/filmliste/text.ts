/**
 * Text folding and FTS5 query construction for the local Filmliste index.
 *
 * Search semantics follow MediathekViewWeb so switching between the local
 * index and the public API does not change which entries a query finds:
 * - German umlauts fold to their two-letter forms (ä → ae, ß → ss), "&" becomes
 *   "und", other accents are dropped, and matching is case-insensitive.
 * - Every word of a query is a prefix match ("tatort" finds "Tatortreiniger").
 * - All words of one query must occur, each in any of the query's fields.
 * - Queries on the same field set are alternatives (OR); groups on different
 *   field sets must all match (AND).
 */
import type { MediathekQueryField } from "@/lib/mediathek-client";

export const SEARCHABLE_FIELDS = ["channel", "topic", "title"] as const;
type SearchableField = (typeof SEARCHABLE_FIELDS)[number];

const FOLDINGS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
};

/** Lowercase, fold umlauts and "&", and strip remaining diacritics. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, "und")
    .replace(/[äöüßæœø]/g, (char) => FOLDINGS[char])
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Search words as MediathekViewWeb tokenizes them: ASCII letters and digits only. */
export function queryTokens(query: string): string[] {
  return foldText(query).match(/[a-z0-9]+/g) ?? [];
}

export class UnsupportedQueryError extends Error {}

function isSearchableField(field: string): field is SearchableField {
  return (SEARCHABLE_FIELDS as readonly string[]).includes(field);
}

/**
 * Build an FTS5 MATCH expression. Returns undefined when there is no query
 * (match everything) and null when a group cannot match anything.
 */
export function buildMatchExpression(queries: MediathekQueryField[]): string | null | undefined {
  if (queries.length === 0) return undefined;
  const groups = new Map<string, string[]>();
  for (const { fields, query } of queries) {
    const unsupported = fields.find((field) => !isSearchableField(field));
    if (unsupported || fields.length === 0) {
      throw new UnsupportedQueryError(`Field "${unsupported ?? ""}" is not indexed locally`);
    }
    const columns = [...new Set(fields)].sort();
    const key = columns.join(" ");
    const tokens = queryTokens(query);
    const alternatives = groups.get(key) ?? [];
    if (tokens.length > 0) {
      alternatives.push(tokens.map((token) => `{${key}} : "${token}"*`).join(" AND "));
    }
    groups.set(key, alternatives);
  }
  const clauses: string[] = [];
  for (const alternatives of groups.values()) {
    // A query without searchable words matches nothing, as in MediathekViewWeb.
    if (alternatives.length === 0) return null;
    clauses.push(`(${alternatives.map((alternative) => `(${alternative})`).join(" OR ")})`);
  }
  return clauses.join(" AND ");
}
