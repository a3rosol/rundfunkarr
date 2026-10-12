import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilmlisteEntry } from "./parser";
import { FilmlisteStore, resolveFilmlistePath } from "./store";

const LIST_1 = 1_760_000_000;
const LIST_2 = LIST_1 + 7200;

function film(title: string, overrides: Partial<FilmlisteEntry> = {}): FilmlisteEntry {
  return {
    channel: "ARD",
    topic: "Tatort",
    title,
    description: "",
    timestamp: LIST_1 - 3600,
    duration: 5400,
    size: 0,
    url_website: "",
    url_subtitle: "",
    url_video: `https://cdn.example/${encodeURIComponent(title)}.mp4`,
    url_video_low: "",
    url_video_hd: "",
    ...overrides,
  };
}

let directory: string;
let store: FilmlisteStore;

function importList(entries: FilmlisteEntry[], listTimestamp: number) {
  const generation = store.beginImport();
  store.writeBatch(entries, generation, listTimestamp);
  store.finishImport(generation, listTimestamp, `list-${listTimestamp}`);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmliste-"));
  store = new FilmlisteStore(path.join(directory, "filmliste.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

const titles = (items: { title: string }[]) => items.map((item) => item.title);

describe("FilmlisteStore", () => {
  it("keeps first-seen times across updates and removes entries missing from the new list", () => {
    importList([film("Alt"), film("Bleibt", { timestamp: LIST_1 + 99_999 })], LIST_1);
    expect(store.search([], 10).map((item) => [item.title, item.filmlisteTimestamp])).toEqual([
      ["Alt", LIST_1 - 3600],
      ["Bleibt", 0],
    ]);
    importList([film("Bleibt", { timestamp: LIST_1 + 99_999 }), film("Neu")], LIST_2);

    const results = store.search([], 10);
    expect(titles(results)).toEqual(["Neu", "Bleibt"]);
    // The first import approximates history with past broadcast times; future entries sort last.
    expect(results.map((item) => item.filmlisteTimestamp)).toEqual([LIST_2, 0]);
    expect(store.info()).toMatchObject({
      entryCount: 2,
      listTimestamp: LIST_2,
      lastModified: `list-${LIST_2}`,
    });
    expect(titles(store.search([{ fields: ["title"], query: "Alt" }], 10))).toEqual([]);
  });

  it("keeps an unfinished import invisible and drops its leftovers on the next attempt", () => {
    importList([film("A"), film("B")], LIST_1);

    // A failed attempt: batches were written, but the import never finished.
    const failed = store.beginImport();
    store.writeBatch([film("B"), film("C")], failed, LIST_2);
    expect(titles(store.search([], 10, { sortBy: "title", sortOrder: "asc" }))).toEqual(["A", "B"]);

    while (store.discardPending() > 0);
    importList([film("A")], LIST_2);
    expect(titles(store.search([], 10))).toEqual(["A"]);
    expect(store.info().entryCount).toBe(1);
  });

  it("updates changed metadata without treating the film as new", () => {
    importList([film("Folge", { description: "alt", size: 1 })], LIST_1);
    importList([film("Folge", { description: "neu", size: 2 })], LIST_2);

    expect(store.search([], 10)).toEqual([
      expect.objectContaining({
        description: "neu",
        size: 2,
        filmlisteTimestamp: LIST_1 - 3600,
      }),
    ]);
  });

  it("searches word prefixes with folded umlauts across the requested fields", () => {
    importList(
      [
        film("Die Höhle der Löwen", { topic: "Die Höhle der Löwen", channel: "VOX" }),
        film("Tatortreiniger", { topic: "Der Tatortreiniger", channel: "NDR" }),
        film("Münster", { channel: "ORF" }),
      ],
      LIST_1
    );

    expect(titles(store.search([{ fields: ["topic", "title"], query: "hoehle LÖW" }], 10))).toEqual(
      ["Die Höhle der Löwen"]
    );
    expect(titles(store.search([{ fields: ["topic", "title"], query: "Hohle" }], 10))).toEqual([]);
    expect(titles(store.search([{ fields: ["title"], query: "tatort" }], 10))).toEqual([
      "Tatortreiniger",
    ]);
    expect(
      titles(
        store.search(
          [
            { fields: ["topic", "title"], query: "Tatort" },
            { fields: ["channel"], query: "ORF" },
          ],
          10
        )
      )
    ).toEqual(["Münster"]);
    expect(
      titles(
        store.search(
          [
            { fields: ["channel"], query: "ORF" },
            { fields: ["channel"], query: "NDR" },
          ],
          10,
          { sortBy: "title", sortOrder: "asc" }
        )
      )
    ).toEqual(["Münster", "Tatortreiniger"]);
  });

  it("filters future entries, sorts by broadcast time and caps results at 1000", () => {
    vi.useFakeTimers({ now: (LIST_1 + 600) * 1000, toFake: ["Date"] });
    importList(
      [
        film("Gestern", { timestamp: LIST_1 - 86_400 }),
        film("Heute", { timestamp: LIST_1 }),
        film("Nächste Woche", { timestamp: LIST_1 + 7 * 86_400 }),
      ],
      LIST_1
    );

    expect(titles(store.search([], 10, { sortBy: "timestamp", future: false }))).toEqual([
      "Heute",
      "Gestern",
    ]);
    expect(titles(store.search([], 10, { sortBy: "timestamp", sortOrder: "asc" }))).toEqual([
      "Gestern",
      "Heute",
      "Nächste Woche",
    ]);

    importList(
      Array.from({ length: 1005 }, (_, index) => film(`Folge ${index}`)),
      LIST_2
    );
    expect(store.search([], 5000)).toHaveLength(1000);
  });

  it("rebuilds an index created by another schema version", () => {
    importList([film("Alt")], LIST_1);
    store.close();
    const file = path.join(directory, "filmliste.db");
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    raw.close();

    store = new FilmlisteStore(file);
    expect(store.info().entryCount).toBe(0);
    expect(store.search([], 10)).toEqual([]);
  });
});

describe("resolveFilmlistePath", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    process.env.DATABASE_URL = original;
  });

  it("places the index next to the main database", () => {
    process.env.DATABASE_URL = "file:/app/prisma/data/rundfunkarr.db";
    expect(resolveFilmlistePath()).toBe("/app/prisma/data/filmliste.db");
    process.env.DATABASE_URL = "file:./data/rundfunkarr.db";
    expect(resolveFilmlistePath()).toBe(path.resolve(process.cwd(), "prisma/data/filmliste.db"));
  });

  it("never resolves to the main database file", () => {
    process.env.DATABASE_URL = "file:/data/filmliste.db";
    expect(resolveFilmlistePath()).toBe("/data/filmliste-index.db");
  });
});
