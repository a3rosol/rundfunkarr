"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { useSettings } from "@/contexts/settings-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ScriptList {
  directory: string;
  scripts: string[];
}

export function PostProcessSettings() {
  const { settings, updateSettings } = useSettings();
  const [script, setScript] = useState<string | null>(null);
  const [list, setList] = useState<ScriptList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const saved = settings?.["download.postProcessScript"] ?? "";
  const current = script ?? saved;
  const missing = current !== "" && list !== null && !list.scripts.includes(current);

  const loadScripts = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/scripts", { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Skripte konnten nicht geladen werden.");
    setList(data);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadScripts(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => controller.abort();
  }, [loadScripts]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await updateSettings({ "download.postProcessScript": current });
      setScript(null);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Post-Processing-Skript</CardTitle>
        <CardDescription>
          Wird wie bei SABnzbd nach Download und Konvertierung ausgeführt, bevor Sonarr oder Radarr
          den Download als abgeschlossen sehen. Ein Fehler des Skripts erscheint als Hinweis in der
          Historie; der Download bleibt abgeschlossen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label htmlFor="post-process-script" className="text-sm font-medium">
            Skript
          </label>
          <div className="mt-1 flex gap-2">
            <select
              id="post-process-script"
              value={current}
              onChange={(e) => setScript(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Kein Skript</option>
              {missing && <option value={current}>{current} (nicht gefunden)</option>}
              {list?.scripts.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              title="Liste aktualisieren"
              aria-label="Skriptliste aktualisieren"
              onClick={() => run(() => loadScripts())}
              disabled={busy}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Ausführbare Dateien aus{" "}
            <code className="break-all">{list?.directory ?? "dem Skriptordner"}</code>. Der Ordner
            lässt sich mit der Umgebungsvariablen <code>POST_PROCESS_SCRIPTS_DIR</code> ändern.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Parameter wie bei SABnzbd: <code>$1</code> Zielordner, <code>$3</code> Name,{" "}
            <code>$5</code> Kategorie, <code>$7</code> Status (0). Zusätzlich stehen{" "}
            <code>SAB_COMPLETE_DIR</code>, <code>SAB_CAT</code>, <code>RUNDFUNKARR_FILE</code> und
            weitere Umgebungsvariablen bereit.
          </p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={save} disabled={busy || current === saved}>
          {busy ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          Speichern
        </Button>
      </CardContent>
    </Card>
  );
}
