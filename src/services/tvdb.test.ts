import { beforeEach, describe, expect, it, vi } from "vitest";
import { tvdbCache } from "@/lib/cache";
import { clearTvdbTokenMemoryCache, getShowInfoByTvdbId } from "./tvdb";

const { fetchWithRetry, findUnique, createSeries, createEpisodes, transaction } = vi.hoisted(
  () => ({
    fetchWithRetry: vi.fn(),
    findUnique: vi.fn(),
    createSeries: vi.fn(),
    createEpisodes: vi.fn(),
    transaction: vi.fn(),
  })
);
vi.mock("@/lib/fetch-retry", () => ({ fetchWithRetry }));
vi.mock("@/lib/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    config: {
      findUnique: vi.fn(async ({ where }) => ({
        value: where.key === "tvdb_token" ? "test-token" : "2099-01-01T00:00:00Z",
      })),
    },
    tvdbSeries: { findUnique },
    $transaction: transaction,
  },
}));

const episode = {
  id: 101,
  name: "CSI Mossy",
  seasonNumber: 6,
  number: 6,
  aired: "2020-03-01",
  runtime: 7,
};
const series = {
  id: 79890,
  name: "Shaun the Sheep",
  nameTranslations: ["eng", "deu"],
  aliases: [{ language: "deu", name: "Shaun" }],
  episodes: [episode, { ...episode, id: 102, number: 7, name: "Original title" }],
};
const base = "https://api4.thetvdb.com/v4/series/79890";
let replies: Map<string, () => Response>;
const success =
  (data: unknown, next: string | null = null) =>
  () =>
    Response.json({ status: "success", data, links: { next } });

beforeEach(() => {
  vi.clearAllMocks();
  clearTvdbTokenMemoryCache();
  tvdbCache.clear();
  findUnique.mockResolvedValue(null);
  transaction.mockImplementation(async (callback) =>
    callback({
      tvdbSeries: { deleteMany: vi.fn(), create: createSeries },
      tvdbEpisode: { deleteMany: vi.fn(), createMany: createEpisodes },
    })
  );
  replies = new Map([
    [`${base}/extended?meta=episodes&short=true`, success(series)],
    [`${base}/translations/deu`, success({ language: "deu", name: "Shaun das Schaf" })],
    [
      `${base}/episodes/default/deu?page=0`,
      success({ episodes: [{ ...episode, name: "Sehr verdächtig" }] }),
    ],
  ]);
  fetchWithRetry.mockImplementation(async (url: string) => {
    const reply = replies.get(url);
    if (!reply) throw new Error(`Unexpected request: ${url}`);
    return reply();
  });
});

describe("TVDB German matching metadata", () => {
  it("uses actual German translations and persists them without losing untranslated episodes", async () => {
    const result = await getShowInfoByTvdbId(79890);

    expect(result?.germanName).toBe("Shaun das Schaf");
    expect(result?.episodes.map((ep) => ep.name)).toEqual(["Sehr verdächtig", "Original title"]);
    expect(result?.episodes[0]).toMatchObject({ seasonNumber: 6, episodeNumber: 6, runtime: 7 });
    expect(createSeries).toHaveBeenCalledWith({
      data: expect.objectContaining({ germanName: "Shaun das Schaf" }),
    });
    expect(createEpisodes).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 101, name: "Sehr verdächtig" }),
        expect.objectContaining({ id: 102, name: "Original title" }),
      ]),
    });
    const calls = fetchWithRetry.mock.calls.length;
    expect(await getShowInfoByTvdbId(79890)).toEqual(result);
    expect(fetchWithRetry).toHaveBeenCalledTimes(calls);
  });

  it("reads all translated pages and joins titles by episode ID, preserving numbering", async () => {
    replies.set(
      `${base}/episodes/default/deu?page=0`,
      success(
        { episodes: [{ ...episode, name: "Sehr verdächtig", number: 99 }] },
        `${base}/episodes/default/deu?page=1`
      )
    );
    replies.set(
      `${base}/episodes/default/deu?page=1`,
      success({
        episodes: [
          { ...episode, id: 102, name: "Nächste Folge" },
          { ...episode, id: 999, name: "Unrelated episode" },
        ],
      })
    );

    const result = await getShowInfoByTvdbId(79890);
    expect(result?.episodes.map((ep) => [ep.name, ep.episodeNumber])).toEqual([
      ["Sehr verdächtig", 6],
      ["Nächste Folge", 7],
    ]);
  });

  it("keeps original titles when translations are missing or blank", async () => {
    replies.set(`${base}/translations/deu`, () => new Response("", { status: 404 }));
    replies.set(
      `${base}/episodes/default/deu?page=0`,
      success({
        episodes: [
          { ...episode, name: " " },
          { ...episode, id: 102, name: null },
        ],
      })
    );
    const result = await getShowInfoByTvdbId(79890);
    expect(result?.germanName).toBe(series.name);
    expect(result?.episodes.map((ep) => ep.name)).toEqual(["CSI Mossy", "Original title"]);
  });

  it("keeps original episode metadata if no translated list exists", async () => {
    replies.set(`${base}/episodes/default/deu?page=0`, () => new Response("", { status: 404 }));
    expect((await getShowInfoByTvdbId(79890))?.episodes[0].name).toBe("CSI Mossy");
  });

  it.each(["series", "episodes", "later-page"])(
    "does not cache incomplete translations after a transient %s failure and recovers",
    async (failure) => {
      const url =
        failure === "series"
          ? `${base}/translations/deu`
          : `${base}/episodes/default/deu?page=${failure === "later-page" ? 1 : 0}`;
      if (failure === "later-page")
        replies.set(
          `${base}/episodes/default/deu?page=0`,
          success({ episodes: [{ ...episode, name: "Sehr verdächtig" }] }, url)
        );
      replies.set(url, () => new Response("unavailable", { status: 503 }));
      expect(await getShowInfoByTvdbId(79890)).toBeNull();
      expect(transaction).not.toHaveBeenCalled();
      expect(tvdbCache.get("tvdb_79890")).toBeUndefined();
      replies.set(
        url,
        failure === "series"
          ? success({ language: "deu", name: "Shaun das Schaf" })
          : success({ episodes: [{ ...episode, name: "Sehr verdächtig" }] })
      );
      expect((await getShowInfoByTvdbId(79890))?.episodes[0].name).toBe("Sehr verdächtig");
    }
  );

  it.each([
    `${base}/episodes/default/deu?page=0`,
    "https://example.org/steal-token?page=1",
    `${base}/episodes/default/deu?page=broken`,
  ])("rejects invalid pagination without forwarding credentials: %s", async (next) => {
    replies.set(`${base}/episodes/default/deu?page=0`, success({ episodes: [] }, next));
    expect(await getShowInfoByTvdbId(79890)).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchWithRetry.mock.calls.every(([url]) => url.startsWith(base))).toBe(true);
    expect(fetchWithRetry.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("reuses persisted German metadata without another API request", async () => {
    findUnique.mockResolvedValue({
      id: 79890,
      name: series.name,
      germanName: "Shaun das Schaf",
      aliases: "[]",
      expiresAt: new Date("2099-01-01"),
      episodes: [{ ...episode, name: "Sehr verdächtig", episodeNumber: 6 }],
    });
    expect((await getShowInfoByTvdbId(79890))?.episodes[0].name).toBe("Sehr verdächtig");
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
