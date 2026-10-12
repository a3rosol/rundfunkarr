/**
 * Local Filmliste index in its own SQLite file next to the main database.
 *
 * Kept outside the Prisma database on purpose: it holds ~700k rows that are
 * rebuilt from the downloaded list, needs FTS5, and can be deleted at any time
 * without losing user data. Writes happen in short synchronous batches, so
 * searches on the same connection never observe an open transaction.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { MediathekQueryField, MediathekQueryOptions } from "@/lib/mediathek-client";
import type { ApiResultItem } from "@/types";
import type { FilmlisteEntry } from "./parser";
import { buildMatchExpression, foldText } from "./text";

const SCHEMA_VERSION = "1";
/** MediathekViewWeb never returns more than 1000 results per query. */
export const MAX_RESULTS = 1000;

const SORT_COLUMNS: Record<string, string> = {
  filmlisteTimestamp: "filmliste_timestamp",
  timestamp: "timestamp",
  duration: "duration",
  channel: "channel",
  topic: "topic",
  title: "title",
};

export interface FilmlisteIndexInfo {
  entryCount: number;
  listTimestamp: number | null;
  lastModified: string | null;
  importedAt: number | null;
  sizeBytes: number;
}

interface EntryRow {
  channel: string;
  topic: string;
  title: string;
  description: string;
  timestamp: number;
  duration: number;
  size: number;
  url_website: string;
  url_subtitle: string;
  url_video: string;
  url_video_low: string;
  url_video_hd: string;
  filmliste_timestamp: number;
}

/** Resolve the index path from DATABASE_URL, which Prisma resolves relative to prisma/. */
export function resolveFilmlistePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./data/rundfunkarr.db";
  const file = url.replace(/^file:/, "").split("?")[0];
  const databasePath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), "prisma", file);
  return path.join(path.dirname(databasePath), "filmliste.db");
}

export function removeIndexFiles(filePath: string) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(filePath + suffix, { force: true });
}

function entryHash(entry: FilmlisteEntry): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        entry.channel,
        entry.topic,
        entry.title,
        entry.description,
        entry.timestamp,
        entry.duration,
        entry.size,
        entry.url_website,
        entry.url_subtitle,
        entry.url_video,
        entry.url_video_low,
        entry.url_video_hd,
      ])
    )
    .digest("base64url");
}

export class FilmlisteStore {
  private db: DatabaseSync;
  private insertEntry: StatementSync;
  private touchEntry: StatementSync;
  private insertSearchText: StatementSync;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = this.openWithSchema();
    this.insertEntry = this.db.prepare(
      `INSERT INTO entries (hash, generation, channel, topic, title, description, timestamp, duration,
         size, url_website, url_subtitle, url_video, url_video_low, url_video_hd, filmliste_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO NOTHING RETURNING id`
    );
    this.touchEntry = this.db.prepare("UPDATE entries SET generation = ? WHERE hash = ?");
    this.insertSearchText = this.db.prepare(
      "INSERT INTO entries_fts (rowid, channel, topic, title) VALUES (?, ?, ?, ?)"
    );
  }

  private openWithSchema(): DatabaseSync {
    let db = new DatabaseSync(this.filePath);
    const version = this.readSchemaVersion(db);
    if (version !== null && version !== SCHEMA_VERSION) {
      // The index is derived data; rebuild it rather than migrating.
      db.close();
      removeIndexFiles(this.filePath);
      db = new DatabaseSync(this.filePath);
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        channel TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        size INTEGER NOT NULL,
        url_website TEXT NOT NULL,
        url_subtitle TEXT NOT NULL,
        url_video TEXT NOT NULL,
        url_video_low TEXT NOT NULL,
        url_video_hd TEXT NOT NULL,
        filmliste_timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_filmliste_timestamp ON entries (filmliste_timestamp);
      CREATE INDEX IF NOT EXISTS entries_timestamp ON entries (timestamp);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (
        channel, topic, title,
        content = '', contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      SCHEMA_VERSION
    );
    return db;
  }

  private readSchemaVersion(db: DatabaseSync): string | null {
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | number) {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(key, String(value));
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  info(): FilmlisteIndexInfo {
    const listTimestamp = Number(this.getMeta("list_timestamp")) || null;
    const importedAt = Number(this.getMeta("imported_at")) || null;
    let sizeBytes = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        sizeBytes += fs.statSync(this.filePath + suffix).size;
      } catch {
        // The WAL file only exists while the database is in use.
      }
    }
    return {
      entryCount: Number(this.getMeta("entry_count")) || 0,
      listTimestamp,
      lastModified: this.getMeta("last_modified"),
      importedAt,
      sizeBytes,
    };
  }

  /** Start an import generation. Entries not seen again are removed by finishImport. */
  beginImport(): number {
    return (Number(this.getMeta("generation")) || 0) + 1;
  }

  /**
   * Store a batch of entries. New entries record when they first appeared, which
   * keeps "sort by newest" (the Newznab RSS feed) stable across list updates.
   * The first import has no history, so it uses each entry's past broadcast time.
   * Undated and future entries (~30k) would otherwise all tie at the list time
   * and crowd recent broadcasts out of the newest 1000 results; they sort last.
   */
  writeBatch(entries: FilmlisteEntry[], generation: number, listTimestamp: number) {
    const initialImport = this.getMeta("list_timestamp") === null;
    this.transaction(() => {
      for (const entry of entries) {
        const hash = entryHash(entry);
        const firstSeen = !initialImport
          ? listTimestamp
          : entry.timestamp > 0 && entry.timestamp <= listTimestamp
            ? entry.timestamp
            : 0;
        const inserted = this.insertEntry.get(
          hash,
          generation,
          entry.channel,
          entry.topic,
          entry.title,
          entry.description,
          entry.timestamp,
          entry.duration,
          entry.size,
          entry.url_website,
          entry.url_subtitle,
          entry.url_video,
          entry.url_video_low,
          entry.url_video_hd,
          firstSeen
        ) as { id: number } | undefined;
        if (inserted) {
          this.insertSearchText.run(
            inserted.id,
            foldText(entry.channel),
            foldText(entry.topic),
            foldText(entry.title)
          );
        } else {
          this.touchEntry.run(generation, hash);
        }
      }
    });
  }

  /** Remove entries missing from this list and record the completed import. */
  finishImport(generation: number, listTimestamp: number, lastModified: string | null) {
    this.transaction(() => {
      for (const sql of [
        "DELETE FROM entries_fts WHERE rowid IN (SELECT id FROM entries WHERE generation < ?)",
        "DELETE FROM entries WHERE generation < ?",
      ]) {
        const statement = this.db.prepare(sql);
        // FTS5 deletes can report an internal last-insert rowid beyond Number.MAX_SAFE_INTEGER.
        statement.setReadBigInts(true);
        statement.run(generation);
      }
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      this.setMeta("generation", generation);
      this.setMeta("list_timestamp", listTimestamp);
      this.setMeta("last_modified", lastModified ?? "");
      this.setMeta("imported_at", Date.now());
      this.setMeta("entry_count", count);
    });
  }

  search(
    queries: MediathekQueryField[],
    size: number,
    options: MediathekQueryOptions = {}
  ): ApiResultItem[] {
    const match = buildMatchExpression(queries);
    if (match === null) return [];
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (match !== undefined) {
      where.push("id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)");
      params.push(match);
    }
    if (options.future === false) {
      // MediathekViewWeb: timestamp <= now + 1h, rounded down to the hour.
      const nowPlusHour = Math.floor(Date.now() / 1000) + 3600;
      where.push("timestamp <= ?");
      params.push(nowPlusHour - (nowPlusHour % 3600));
    }
    const column = SORT_COLUMNS[options.sortBy ?? "filmlisteTimestamp"] ?? "filmliste_timestamp";
    const direction = options.sortOrder === "asc" ? "ASC" : "DESC";
    params.push(Math.max(0, Math.min(Math.floor(size), MAX_RESULTS)));
    const rows = this.db
      .prepare(
        `SELECT channel, topic, title, description, timestamp, duration, size, url_website,
           url_subtitle, url_video, url_video_low, url_video_hd, filmliste_timestamp
         FROM entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${column} ${direction}, id ${direction} LIMIT ?`
      )
      .all(...params) as unknown as EntryRow[];
    return rows.map(({ filmliste_timestamp, ...row }) => ({
      ...row,
      filmlisteTimestamp: filmliste_timestamp,
    }));
  }

  close() {
    this.db.close();
  }
}
