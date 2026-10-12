import { describe, expect, it } from "vitest";
import { parseFilmliste, parseListTimestamp, type FilmlisteRecord } from "./parser";

const HEADER =
  '{"Filmliste":["12.10.2026, 22:19","12.10.2026, 20:19","3","MSearch","id"],' +
  '"Filmliste":["Sender","Thema","Titel","Datum","Zeit","Dauer","Größe [MB]","Beschreibung","Url",' +
  '"Website","Url Untertitel","Url RTMP","Url Klein","Url RTMP Klein","Url HD","Url RTMP HD",' +
  '"DatumL","Url History","Geo","neu"]';

function entry(fields: Partial<Record<number, string>>): string {
  const row = Array.from({ length: 20 }, (_, index) => fields[index] ?? "");
  return JSON.stringify(row);
}

const LIST =
  HEADER +
  ',"X":' +
  entry({
    0: "ARD",
    1: "Tatort",
    2: "Der Fall",
    5: "01:28:30",
    6: "1200",
    7: "Beschreibung",
    8: "https://cdn.example/video/tatort_1800.mp4",
    9: "https://ard.example/tatort",
    10: "https://ard.example/sub.vtt",
    12: "32|_480.mp4",
    14: "32|_3200.mp4",
    16: "1760000000",
  }) +
  ',"X":' +
  entry({ 2: "Der zweite Fall", 5: "00:45:00", 8: "https://cdn.example/b.mp4", 16: "1760003600" }) +
  ',"X":' +
  entry({ 0: "ZDF", 2: "Ohne Thema", 8: "https://cdn.example/c.mp4" }) +
  ',"X":' +
  entry({ 1: "Doku", 2: "Wir haben genug - Wirtschaft ohne Wachstum", 8: "https://x/d.mp4" }) +
  ',"X":["kaputt"]' +
  "}";

async function collect(text: string, chunkSize: number) {
  async function* chunks() {
    for (let index = 0; index < text.length; index += chunkSize) {
      yield text.slice(index, index + chunkSize);
    }
  }
  const stats = { skipped: 0 };
  const records: FilmlisteRecord[] = [];
  for await (const record of parseFilmliste(chunks(), stats)) records.push(record);
  return { records, stats };
}

describe("parseListTimestamp", () => {
  it("reads the UTC creation time from the second meta field", () => {
    expect(parseListTimestamp(HEADER)).toBe(Date.UTC(2026, 9, 12, 20, 19) / 1000);
  });
});

describe("parseFilmliste", () => {
  it.each([1, 7, 64, LIST.length])(
    "parses entries split into %i-character chunks",
    async (size) => {
      const { records, stats } = await collect(LIST, size);
      expect(records[0]).toEqual({
        type: "meta",
        listTimestamp: Date.UTC(2026, 9, 12, 20, 19) / 1000,
      });
      const entries = records.flatMap((record) => (record.type === "entry" ? [record.entry] : []));
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({
        channel: "ARD",
        topic: "Tatort",
        title: "Der Fall",
        description: "Beschreibung",
        timestamp: 1760000000,
        duration: 5310,
        size: 1200 * 1024 * 1024,
        url_website: "https://ard.example/tatort",
        url_subtitle: "https://ard.example/sub.vtt",
        url_video: "https://cdn.example/video/tatort_1800.mp4",
        url_video_low: "https://cdn.example/video/tatort_480.mp4",
        url_video_hd: "https://cdn.example/video/tatort_3200.mp4",
      });
      // Empty channel and topic repeat the previous entry's values.
      expect(entries[1]).toMatchObject({ channel: "ARD", topic: "Tatort", duration: 2700 });
      expect(entries[2]).toMatchObject({ channel: "ZDF", topic: "Tatort", url_video_hd: "" });
      expect(stats.skipped).toBe(1);
    }
  );

  it("rejects a truncated list", async () => {
    await expect(collect(LIST.slice(0, -40), 50)).rejects.toThrow("ended unexpectedly");
  });
});
