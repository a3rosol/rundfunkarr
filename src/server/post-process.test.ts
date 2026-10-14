import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  listPostProcessScripts,
  resolveScriptsDirectory,
  runPostProcessScript,
  type PostProcessJob,
} from "./post-process";

let root: string;
let scripts: string;
let job: PostProcessJob;

async function script(name: string, body: string, mode = 0o755): Promise<void> {
  const file = path.join(scripts, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rundfunkarr-post-process-"));
  scripts = path.join(root, "scripts");
  await mkdir(scripts);
  await mkdir(path.join(root, "tv", "job-1"), { recursive: true });
  vi.stubEnv("POST_PROCESS_SCRIPTS_DIR", scripts);
  job = {
    id: "job-1",
    title: "Tatort S01E01",
    category: "tv",
    url: "https://example.com/video.mp4",
    filePath: path.join(root, "tv", "job-1", "Tatort S01E01.mkv"),
    storagePath: "/mapped/tv/job-1/Tatort S01E01.mkv",
    size: 1234,
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("resolveScriptsDirectory", () => {
  it("defaults to a scripts folder next to the database", () => {
    vi.stubEnv("POST_PROCESS_SCRIPTS_DIR", "");
    vi.stubEnv("DATABASE_URL", "file:/app/prisma/data/rundfunkarr.db");
    expect(resolveScriptsDirectory()).toBe("/app/prisma/data/scripts");
    vi.stubEnv("DATABASE_URL", "file:./data/rundfunkarr.db");
    expect(resolveScriptsDirectory()).toBe(path.resolve(process.cwd(), "prisma/data/scripts"));
  });

  it("uses POST_PROCESS_SCRIPTS_DIR when set", () => {
    expect(resolveScriptsDirectory()).toBe(scripts);
  });
});

describe("listPostProcessScripts", () => {
  it("lists executable files only", async () => {
    await script("notify.sh", "exit 0");
    await script("b-move.sh", "exit 0");
    await script("readme.txt", "", 0o644);
    await script(".hidden.sh", "exit 0");
    await mkdir(path.join(scripts, "folder"));

    await expect(listPostProcessScripts()).resolves.toEqual(["b-move.sh", "notify.sh"]);
  });

  it("returns an empty list when the folder does not exist", async () => {
    await expect(listPostProcessScripts(path.join(root, "missing"))).resolves.toEqual([]);
  });
});

describe("runPostProcessScript", () => {
  it("passes SABnzbd-compatible parameters and variables", async () => {
    const out = path.join(root, "out.txt");
    await script(
      "record.sh",
      `printf '%s\\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$(pwd -P)" "$SAB_COMPLETE_DIR" \
"$SAB_FINAL_NAME" "$SAB_CAT" "$SAB_NZO_ID" "$SAB_PP_STATUS" "$SAB_BYTES" \
"$RUNDFUNKARR_FILE" "$RUNDFUNKARR_STORAGE_PATH" > "${out}"`
    );

    await expect(runPostProcessScript("record.sh", job)).resolves.toBeNull();

    const jobDir = path.join(root, "tv", "job-1");
    const lines = (await readFile(out, "utf8")).split("\n");
    expect(lines.slice(0, 7)).toEqual([
      jobDir,
      "Tatort S01E01.nzb",
      "Tatort S01E01",
      "",
      "tv",
      "",
      "0",
    ]);
    expect(lines[7]).toBe(await realpath(jobDir));
    expect(lines.slice(8, 16)).toEqual([
      jobDir,
      "Tatort S01E01",
      "tv",
      "job-1",
      "0",
      "1234",
      job.filePath,
      job.storagePath,
    ]);
  });

  it("reports a failing script with its exit code and last output line", async () => {
    await script("fail.sh", 'echo "copying"\necho "disk full" >&2\nexit 3');

    await expect(runPostProcessScript("fail.sh", job)).resolves.toBe(
      "Skript fail.sh: Exit(3) disk full"
    );
    expect(console.log).toHaveBeenCalledWith("[Script] fail.sh: copying");
  });

  it("keeps umlauts intact that arrive split across output chunks", async () => {
    // "ä" is 0xC3 0xA4 in UTF-8; the pause separates the two bytes.
    await script("umlaut.sh", "printf '\\303'\nsleep 0.2\nprintf '\\244rger\\n'\nexit 1");

    await expect(runPostProcessScript("umlaut.sh", job)).resolves.toBe(
      "Skript umlaut.sh: Exit(1) ärger"
    );
  });

  it.each(["../escape.sh", "missing.sh", ".hidden.sh"])("refuses %s", async (name) => {
    await writeFile(path.join(root, "escape.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await script(".hidden.sh", "exit 0");

    await expect(runPostProcessScript(name, job)).resolves.toContain("nicht gefunden");
  });

  it("refuses a script that is not executable", async () => {
    await script("plain.sh", "exit 0", 0o644);

    await expect(runPostProcessScript("plain.sh", job)).resolves.toContain("nicht ausführbar");
  });

  it("stops a script that exceeds the time limit", async () => {
    await script("hang.sh", "sleep 30");

    await expect(runPostProcessScript("hang.sh", job, undefined, 200)).resolves.toContain(
      "abgebrochen"
    );
  });

  it("stops a script when the download is cancelled", async () => {
    await script("hang.sh", "sleep 30");
    const controller = new AbortController();
    setTimeout(() => controller.abort("cancel"), 200);

    await expect(runPostProcessScript("hang.sh", job, controller.signal)).resolves.toBe(
      "Skript hang.sh wurde abgebrochen."
    );
  });
});
