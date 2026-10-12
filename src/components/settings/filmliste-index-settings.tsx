"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { useSettings } from "@/contexts/settings-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface FilmlisteStatus {
  enabled: boolean;
  usable: boolean;
  running: boolean;
  entryCount: number;
  processedEntries: number;
  listTimestamp: number | null;
  importedAt: number | null;
  lastCheckAt: number | null;
  lastError: string | null;
  sizeBytes: number;
}

const formatDate = (milliseconds: number | null) =>
  milliseconds ? new Date(milliseconds).toLocaleString("de-DE") : "–";
const formatNumber = (value: number) => value.toLocaleString("de-DE");
const formatMegabytes = (bytes: number) => `${formatNumber(Math.round(bytes / 1024 / 1024))} MB`;

function statusBadge(status: FilmlisteStatus) {
  if (!status.enabled) return <Badge variant="outline">MediathekViewWeb</Badge>;
  if (status.usable) return <Badge>Lokal</Badge>;
  if (status.running) return <Badge variant="secondary">Index wird aufgebaut</Badge>;
  return <Badge variant="destructive">Lokal nicht bereit</Badge>;
}

export function FilmlisteIndexSettings() {
  const { settings, updateSettings } = useSettings();
  const [source, setSource] = useState<string | null>(null);
  const [hours, setHours] = useState<string | null>(null);
  const [status, setStatus] = useState<FilmlisteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  const currentSource = source ?? settings?.["mediathek.source"] ?? "mediathekviewweb";
  const localSelected = currentSource === "local";
  const currentHours = hours ?? settings?.["mediathek.localIndex.updateHours"] ?? "2";

  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<FilmlisteStatus> => {
    const response = await fetch("/api/filmliste", { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Status konnte nicht geladen werden.");
    setStatus(data);
    return data;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadStatus(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => controller.abort();
  }, [loadStatus]);

  // Follow a running import until it finishes.
  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(() => void loadStatus().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [status?.running, loadStatus]);

  async function request(method: "POST" | "DELETE") {
    const response = await fetch("/api/filmliste", { method });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Aktion fehlgeschlagen.");
    setStatus(data);
  }

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
      const parsedHours = Math.min(24, Math.max(1, Math.round(Number(currentHours)) || 2));
      await updateSettings({
        "mediathek.source": currentSource,
        "mediathek.localIndex.updateHours": String(parsedHours),
      });
      setSource(null);
      setHours(null);
      const fresh = await loadStatus();
      // Build the index right away instead of waiting for the scheduler.
      if (localSelected && !fresh.running && fresh.entryCount === 0) {
        await request("POST");
      }
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Mediathek-Suchquelle {status && statusBadge(status)}
        </CardTitle>
        <CardDescription>
          Woher Suche, Newznab-Feed und Suchabos ihre MediathekView-Treffer beziehen. Der lokale
          Index lädt die Filmliste selbst und durchsucht sie ohne mediathekviewweb.de. Er benötigt
          etwa 800 MB Speicher und pro Aktualisierung rund 80 MB Download. Solange er nicht bereit
          oder älter als 24 Stunden ist, wird weiterhin MediathekViewWeb verwendet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label htmlFor="mediathek-source" className="text-sm font-medium">
            Suchquelle
          </label>
          <select
            id="mediathek-source"
            value={currentSource}
            onChange={(e) => setSource(e.target.value)}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="mediathekviewweb">MediathekViewWeb (online)</option>
            <option value="local">Lokaler Filmlisten-Index</option>
          </select>
        </div>
        <div hidden={!localSelected}>
          <label className="text-sm font-medium">Aktualisierung alle (Stunden)</label>
          <Input
            type="number"
            min={1}
            max={24}
            value={currentHours}
            onChange={(e) => setHours(e.target.value)}
            className="mt-1 w-24"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Unveränderte Listen werden nicht erneut geladen.
          </p>
        </div>

        {status && (status.enabled || status.entryCount > 0) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Einträge</dt>
            <dd>
              {status.running
                ? `${formatNumber(status.processedEntries)} verarbeitet …`
                : formatNumber(status.entryCount)}
            </dd>
            <dt className="text-muted-foreground">Filmliste vom</dt>
            <dd>{formatDate(status.listTimestamp && status.listTimestamp * 1000)}</dd>
            <dt className="text-muted-foreground">Letzter Import</dt>
            <dd>{formatDate(status.importedAt)}</dd>
            <dt className="text-muted-foreground">Letzte Prüfung</dt>
            <dd>{formatDate(status.lastCheckAt)}</dd>
            <dt className="text-muted-foreground">Speicherbedarf</dt>
            <dd>{formatMegabytes(status.sizeBytes)}</dd>
          </dl>
        )}
        {status?.lastError && (
          <p className="text-sm text-destructive">
            Letzte Aktualisierung fehlgeschlagen: {status.lastError}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy}>
            {busy ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Speichern
          </Button>
          {status?.enabled && (
            <Button
              variant="outline"
              onClick={() => run(() => request("POST"))}
              disabled={busy || status.running}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${status.running ? "animate-spin" : ""}`} />
              {status.running ? "Wird aktualisiert …" : "Jetzt aktualisieren"}
            </Button>
          )}
          {status && status.entryCount > 0 && (
            <Button
              variant="outline"
              onClick={() =>
                confirmDelete
                  ? run(async () => {
                      setConfirmDelete(false);
                      await request("DELETE");
                    })
                  : setConfirmDelete(true)
              }
              disabled={busy || status.running}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {confirmDelete ? "Wirklich löschen?" : "Index löschen"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
