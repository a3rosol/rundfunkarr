import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting } from "@/lib/settings";

vi.mock("@/lib/settings", () => ({ getSetting: vi.fn() }));

const LIST_CREATED = "12.10.2026, 20:19";
const LIST_TIMESTAMP = Date.UTC(2026, 9, 12, 20, 19) / 1000;
const ENTRY_COUNT = 50_001;

function compressedList(entries: number): Buffer {
  const header =
    `{"Filmliste":["","${LIST_CREATED}","3","MSearch","id"],` + '"Filmliste":["Sender"]';
  const rows = Array.from(
    { length: entries },
    (_, index) =>
      ',"X":' +
      JSON.stringify([
        index === 0 ? "ARD" : "",
        index === 0 ? "Tatort" : "",
        `Folge ${index}`,
        "",
        "",
        "01:30:00",
        "1",
        "",
        `https://cdn.example/${index}.mp4`,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        String(LIST_TIMESTAMP - index),
      ])
  );
  return execFileSync("xz", ["-z", "-0", "-T1"], { input: header + rows.join("") + "}" });
}

let directory: string;
let fullList: Buffer;
const fetchMock = vi.fn();
const originalDatabaseUrl = process.env.DATABASE_URL;

function serve(body: Buffer, lastModified: number) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const headers = { "last-modified": new Date(lastModified * 1000).toUTCString() };
    return init?.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(new Uint8Array(body), { headers });
  });
}

beforeAll(() => {
  fullList = compressedList(ENTRY_COUNT);
});

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmliste-update-"));
  process.env.DATABASE_URL = `file:${path.join(directory, "rundfunkarr.db")}`;
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getSetting).mockImplementation(async (key) =>
    key === "mediathek.source" ? "local" : null
  );
  vi.useFakeTimers({ now: (LIST_TIMESTAMP + 1800) * 1000, toFake: ["Date"] });
});

afterEach(async () => {
  const { deleteFilmlisteIndex } = await import(".");
  deleteFilmlisteIndex();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

afterAll(() => {
  process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("updateFilmliste", () => {
  it("imports the list, answers searches locally and skips an unchanged list", async () => {
    const { getFilmlisteStatus, searchLocalFilmliste, updateFilmliste } = await import(".");
    serve(fullList, LIST_TIMESTAMP + 1500);

    expect(await updateFilmliste()).toBe("updated");
    expect(await getFilmlisteStatus()).toMatchObject({
      entryCount: ENTRY_COUNT,
      listTimestamp: LIST_TIMESTAMP,
      usable: true,
      lastError: null,
    });
    const results = await searchLocalFilmliste([{ fields: ["title"], query: "Folge 42" }], 5);
    expect(results?.[0]).toMatchObject({ channel: "ARD", topic: "Tatort", title: "Folge 42" });

    // Another mirror reports a slightly different time for the same list.
    serve(fullList, LIST_TIMESTAMP + 1520);
    fetchMock.mockClear();
    expect(await updateFilmliste()).toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("keeps the previous index when a download is truncated", async () => {
    const { getFilmlisteStatus, updateFilmliste } = await import(".");
    serve(compressedList(10), LIST_TIMESTAMP + 1500);

    expect(await updateFilmliste()).toBe("failed");
    expect(await getFilmlisteStatus()).toMatchObject({ entryCount: 0, usable: false });
    expect((await getFilmlisteStatus()).lastError).toContain("unvollständig");
  });

  it("waits a quarter interval before retrying a failed first import", async () => {
    const { runScheduledUpdate } = await import(".");
    serve(compressedList(10), LIST_TIMESTAMP + 1500);

    await runScheduledUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await runScheduledUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Default interval: 2 hours, so the retry follows after 30 minutes.
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await runScheduledUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to the public API when disabled or outdated", async () => {
    const { searchLocalFilmliste, updateFilmliste } = await import(".");
    serve(fullList, LIST_TIMESTAMP + 1500);
    await updateFilmliste();

    vi.setSystemTime((LIST_TIMESTAMP + 25 * 3600) * 1000);
    expect(await searchLocalFilmliste([], 1)).toBeUndefined();

    vi.setSystemTime((LIST_TIMESTAMP + 1800) * 1000);
    expect(await searchLocalFilmliste([], 1)).toHaveLength(1);
    vi.mocked(getSetting).mockResolvedValue("mediathekviewweb");
    expect(await searchLocalFilmliste([], 1)).toBeUndefined();
  }, 30_000);
});
