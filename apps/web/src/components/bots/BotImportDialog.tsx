import { useAtomValue } from "@effect/atom-react";
import {
  type Bot,
  type BotExportInput,
  type BotImportCandidate,
  type BotImportScanResult,
  type BotImportSource,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { requestConfirmDialog } from "../../confirmDialog";
import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { msg } from "gt-react";
import { BotAvatar } from "./BotAvatar";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  downloadTextFile,
  importMemoryLabel,
  importModelLine,
  modelSelectionLabel,
} from "./botPage.logic";

type SourceKind = "openbot" | "folder" | "package";

export function BotImportDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onImported: (bots: ReadonlyArray<Bot>) => void;
}) {
  const { environmentId, onClose, onImported } = props;
  const gt = useGT();
  const resolve = useMessages();
  const scanBotImport = useAtomCommand(serverEnvironment.scanBotImport, {
    label: "bot import scan",
  });
  const applyBotImport = useAtomCommand(serverEnvironment.applyBotImport, {
    label: "bot import apply",
  });
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );

  const [sourceKind, setSourceKind] = useState<SourceKind>("openbot");
  const [folderPath, setFolderPath] = useState("");
  const [packageContent, setPackageContent] = useState<string | null>(null);
  const [packageName, setPackageName] = useState<string | null>(null);
  const [result, setResult] = useState<BotImportScanResult | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [include, setInclude] = useState({ memory: true, skills: true, automations: true });
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptions = instanceEntries.flatMap((entry) =>
    entry.models.map((model) => ({
      value: `${entry.instanceId}|${model.slug}`,
      label: `${model.name} (${entry.instanceId})`,
      selection: {
        instanceId: entry.instanceId,
        model: model.slug,
      } satisfies ModelSelection,
    })),
  );
  // "SWE-2 · Devin" for models this server knows; the raw slug when it doesn't.
  const selectionLabel = (selection: { instanceId: string; model: string }): string => {
    const entry = instanceEntries.find((item) => item.instanceId === selection.instanceId);
    const model = entry?.models.find((item) => item.slug === selection.model);
    return entry !== undefined && model !== undefined
      ? `${model.name} · ${entry.displayName}`
      : modelSelectionLabel(selection);
  };
  const [fallbackValue, setFallbackValue] = useState(modelOptions[0]?.value ?? "");
  const fallback =
    modelOptions.find((option) => option.value === fallbackValue)?.selection ??
    modelOptions[0]?.selection;
  const fallbackLabel =
    fallback === undefined ? resolve(msg("no model")) : selectionLabel(fallback);
  const selectedProjectId = projectId ?? projects[0]?.id ?? null;

  const source = (): BotImportSource | null => {
    if (sourceKind === "openbot") return { type: "openbot" };
    if (sourceKind === "folder") {
      return folderPath.trim() === "" ? null : { type: "folder", path: folderPath.trim() };
    }
    return packageContent === null ? null : { type: "package", content: packageContent };
  };

  const runScan = async (src: BotImportSource) => {
    setBusy(true);
    setScanError(null);
    setResult(null);
    const next = await scanBotImport({ environmentId, input: { source: src } });
    setBusy(false);
    if (next._tag === "Failure") {
      if (!isAtomCommandInterrupted(next)) {
        setScanError(String(squashAtomCommandFailure(next)));
      }
      return;
    }
    setResult(next.value);
    setChecked(new Set(next.value.candidates.map((candidate) => candidate.key)));
  };

  const scan = () => {
    const src = source();
    if (src !== null) void runScan(src);
  };

  // Local-install sources scan as soon as they are picked; folder waits for Scan.
  const pickSourceKind = (kind: SourceKind) => {
    setSourceKind(kind);
    setResult(null);
    setScanError(null);
    if (kind === "openbot") void runScan({ type: "openbot" });
  };

  const apply = async () => {
    const src = source();
    if (src === null || fallback === undefined || selectedProjectId === null) return;
    setBusy(true);
    const next = await applyBotImport({
      environmentId,
      input: {
        source: src,
        keys: [...checked],
        projectId: selectedProjectId,
        fallbackModelSelection: fallback,
        include,
      },
    });
    setBusy(false);
    if (next._tag === "Failure") {
      if (!isAtomCommandInterrupted(next)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Import failed"),
            description: String(squashAtomCommandFailure(next)),
          }),
        );
      }
      return;
    }
    const warnings = next.value.warnings;
    toastManager.add(
      stackedThreadToast({
        type: warnings.length === 0 ? "success" : "warning",
        title:
          next.value.bots.length === 1
            ? gt("Imported {count} bot", { count: next.value.bots.length })
            : gt("Imported {count} bots", { count: next.value.bots.length }),
        description:
          warnings.length === 0
            ? undefined
            : [
                ...warnings.slice(0, 3),
                ...(warnings.length > 3
                  ? [gt("and {count} more", { count: warnings.length - 3 })]
                  : []),
              ].join("\n"),
      }),
    );
    onImported(next.value.bots);
  };

  const onPackageFile = (files: FileList | null) => {
    const file = files?.[0];
    if (file === undefined) return;
    void file.text().then((text) => {
      setPackageContent(text);
      setPackageName(file.name);
      void runScan({ type: "package", content: text });
    });
  };

  const candidates = result?.candidates ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{gt("Import bots")}</DialogTitle>
        <DialogDescription>
          <T>
            Import bot profiles, instructions, memory, skills and routines from another app or a
            file. Routines are imported as disabled automations.
          </T>
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-2xs font-semibold text-muted-foreground">
              <T>Source</T>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(["openbot", "folder", "package"] as const).map((kind) => (
                <Button
                  key={kind}
                  size="sm"
                  variant={sourceKind === kind ? "default" : "outline"}
                  onClick={() => pickSourceKind(kind)}
                >
                  {kind === "openbot" ? (
                    <T>OpenBot (this computer)</T>
                  ) : kind === "folder" ? (
                    <T>Agent folder</T>
                  ) : (
                    <T>SimplyCode file</T>
                  )}
                </Button>
              ))}
            </div>
            {sourceKind === "folder" ? (
              <div className="flex items-center gap-1.5">
                <Input
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.currentTarget.value)}
                  placeholder={gt("Path on the server, e.g. C:\\agents\\my-bot")}
                  aria-label={gt("Agent folder path")}
                />
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={scan}
                  disabled={folderPath.trim() === "" || busy}
                >
                  {busy && result === null ? <Spinner className="size-3.5" /> : null}
                  <T>Scan</T>
                </Button>
              </div>
            ) : null}
            {sourceKind === "package" ? (
              <div className="flex items-center gap-2">
                <label className="cursor-pointer text-2xs text-primary hover:underline">
                  <T>Choose a *.simplycode-bots.json file</T>
                  <input
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(event) => onPackageFile(event.currentTarget.files)}
                  />
                </label>
                {packageName !== null ? (
                  <span className="truncate text-2xs text-muted-foreground">{packageName}</span>
                ) : null}
              </div>
            ) : null}
            {busy && result === null && sourceKind !== "folder" ? (
              <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <Spinner className="size-3.5" />
                <T>Scanning…</T>
              </div>
            ) : null}
            {scanError !== null ? <p className="text-2xs text-destructive">{scanError}</p> : null}
          </div>

          {result !== null ? (
            <>
              <div className="flex flex-col gap-1.5">
                <p className="text-2xs font-semibold text-muted-foreground">
                  {gt("Found in {source}", { source: result.sourceLabel })}
                </p>
                {candidates.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-2xs text-muted-foreground">
                    <T>No bots found.</T>
                  </p>
                ) : (
                  <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border/60 p-1.5">
                    {candidates.map((candidate) => (
                      <CandidateRow
                        key={candidate.key}
                        candidate={candidate}
                        checked={checked.has(candidate.key)}
                        fallbackLabel={fallbackLabel}
                        selectionLabel={selectionLabel}
                        onCheckedChange={(next) =>
                          setChecked((current) => {
                            const updated = new Set(current);
                            if (next === true) updated.add(candidate.key);
                            else updated.delete(candidate.key);
                            return updated;
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </div>

              {candidates.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {(
                      [
                        ["memory", gt("Memory")],
                        ["skills", gt("Skills")],
                        ["automations", gt("Automations (imported disabled)")],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-1.5 text-2xs"
                      >
                        <Checkbox
                          checked={include[key]}
                          onCheckedChange={(next) =>
                            setInclude((current) => ({ ...current, [key]: next === true }))
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <p className="text-2xs font-semibold text-muted-foreground">
                        <T>Project</T>
                      </p>
                      <Select
                        value={selectedProjectId ?? ""}
                        onValueChange={(value) => setProjectId(value as ProjectId)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={gt("Select a project")}>
                            {projects.find((project) => project.id === selectedProjectId)?.title}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id} label={project.title}>
                              <span className="block truncate">{project.title}</span>
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <p className="text-2xs font-semibold text-muted-foreground">
                        <T>Fallback model</T>
                      </p>
                      <Select
                        value={fallbackValue}
                        onValueChange={(value) => setFallbackValue(value as string)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {modelOptions.find((option) => option.value === fallbackValue)?.label}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {modelOptions.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              label={option.label}
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" onClick={onClose}>
                      <T>Cancel</T>
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void apply()}
                      disabled={
                        busy ||
                        checked.size === 0 ||
                        fallback === undefined ||
                        selectedProjectId === null
                      }
                    >
                      {busy ? <Spinner className="size-3.5" /> : null}
                      {m("{count, plural, =1 {Import # bot} other {Import # bots}}", {
                        count: checked.size,
                      })}
                    </Button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </DialogPanel>
    </>
  );
}

function CandidateRow(props: {
  readonly candidate: BotImportCandidate;
  readonly checked: boolean;
  readonly fallbackLabel: string;
  readonly selectionLabel: (selection: { instanceId: string; model: string }) => string;
  readonly onCheckedChange: (next: boolean) => void;
}) {
  const { candidate, checked, fallbackLabel, selectionLabel, onCheckedChange } = props;
  const resolve = useMessages();
  const importableAutomations = candidate.automations.filter(
    (automation) => automation.importable,
  ).length;
  return (
    <div className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-muted/50">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={candidate.name}
        className="mt-0.5"
      />
      <BotAvatar
        bot={{ id: candidate.key, name: candidate.name, avatar: candidate.avatar }}
        size={24}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">
          {candidate.name}
          {candidate.role !== undefined ? (
            <span className="font-normal text-muted-foreground"> · {candidate.role}</span>
          ) : null}
        </p>
        <p className="truncate text-2xs text-muted-foreground">
          {importModelLine(candidate, fallbackLabel, resolve, selectionLabel)}
        </p>
        <p className="text-2xs text-muted-foreground">
          {m("{count, plural, =1 {# skill} other {# skills}}", {
            count: candidate.skills.length,
          })}{" "}
          · {m("instructions {size}", { size: formatBytes(candidate.soulBytes) })} ·{" "}
          {importMemoryLabel(candidate.memoryBytes, resolve)} ·{" "}
          {m("{count, plural, =1 {# automation} other {# automations}}", {
            count: importableAutomations,
          })}{" "}
          · {candidate.approvalMode}
        </p>
        {candidate.warnings.length > 0 ? (
          <details className="text-2xs text-muted-foreground">
            <summary className="cursor-pointer">
              {m("{count} warnings", { count: candidate.warnings.length })}
            </summary>
            <ul className="list-disc pl-4">
              {candidate.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** The shared export flow: confirm memory, call exportBots, download the file. */
export async function exportBotsToFile(
  exportBots: (
    input: BotExportInput,
  ) => Promise<AtomCommandResult<{ fileName: string; content: string }, unknown>>,
  ids: BotExportInput["ids"],
  reportFailure: (error: unknown) => void,
): Promise<void> {
  const includeMemory =
    (await requestConfirmDialog(m("Include memory (MEMORY.md) in the export?"))) ?? false;
  const result = await exportBots({ ids, includeMemory });
  if (result._tag === "Failure") {
    reportFailure(squashAtomCommandFailure(result));
    return;
  }
  downloadTextFile(result.value.fileName, result.value.content);
}
