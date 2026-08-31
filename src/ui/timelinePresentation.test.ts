import { describe, expect, it } from "vitest";

import { findCatalog, translationCatalogs } from "../i18n/catalog";
import {
  commandOutputText,
  formatCompactElapsedSeconds,
  formatElapsedSeconds,
  commandActivityTitle as rawCommandActivityTitle,
  commandHeadline as rawCommandHeadline,
  commandLiveOutputText as rawCommandLiveOutputText,
  commandPollActivityTitle as rawCommandPollActivityTitle,
  confirmedOutputTokenLabel as rawConfirmedOutputTokenLabel,
  fileChangeActionLabel as rawFileChangeActionLabel,
  fileChangeGroupTitle as rawFileChangeGroupTitle,
  fileReadActivityTitle as rawFileReadActivityTitle,
  fileReadItemTitle as rawFileReadItemTitle,
  reasoningTitle as rawReasoningTitle,
  runningCommandHeadline as rawRunningCommandHeadline,
  terminalReadActivityTitle as rawTerminalReadActivityTitle,
  toolActivityTitle as rawToolActivityTitle,
  turnDurationLabel as rawTurnDurationLabel,
  shouldShowCommandDurationSuffix,
  thinkingPresentation,
  toolOutputText,
  userMessageMarkerWidth,
  visibleCommandDurationMs,
} from "./timelinePresentation";

const messages = findCatalog(translationCatalogs, "pt-BR")?.messages.timeline;
if (messages === undefined) throw new Error("The Brazilian Portuguese catalog is unavailable.");

const turnDurationLabel = (status: Parameters<typeof rawTurnDurationLabel>[0], duration: string) =>
  rawTurnDurationLabel(status, duration, messages);
const confirmedOutputTokenLabel = (tokens: number) =>
  rawConfirmedOutputTokenLabel(tokens, messages, "pt-BR");
const runningCommandHeadline = (duration: string | null, fallback: string) =>
  rawRunningCommandHeadline(duration, fallback, messages);
const reasoningTitle = (
  summary: readonly string[],
  state: Parameters<typeof rawReasoningTitle>[1] = "completed",
) => rawReasoningTitle(summary, state);
const commandActivityTitle = (
  command: string,
  status: Parameters<typeof rawCommandActivityTitle>[1],
  expanded: boolean,
) => rawCommandActivityTitle(command, status, expanded, messages);
const commandHeadline = (
  command: string,
  status: Parameters<typeof rawCommandHeadline>[1],
  expanded: boolean,
  duration: string | null,
) => rawCommandHeadline(command, status, expanded, duration, messages);
const toolActivityTitle = (
  description: string,
  status: Parameters<typeof rawToolActivityTitle>[1],
  expanded: boolean,
) => rawToolActivityTitle(description, status, expanded, messages);
const commandPollActivityTitle = (status: Parameters<typeof rawCommandPollActivityTitle>[0]) =>
  rawCommandPollActivityTitle(status, messages);
const terminalReadActivityTitle = (status: Parameters<typeof rawTerminalReadActivityTitle>[0]) =>
  rawTerminalReadActivityTitle(status, messages);
const fileReadActivityTitle = (
  status: Parameters<typeof rawFileReadActivityTitle>[0],
  count?: number,
) => rawFileReadActivityTitle(status, messages, count);
const fileReadItemTitle = (status: Parameters<typeof rawFileReadItemTitle>[0], name: string) =>
  rawFileReadItemTitle(status, name, messages);
const fileChangeGroupTitle = (count: number) => rawFileChangeGroupTitle(count, messages);
const fileChangeActionLabel = (kind: Parameters<typeof rawFileChangeActionLabel>[0]) =>
  rawFileChangeActionLabel(kind, messages);
const commandLiveOutputText = (output: Parameters<typeof rawCommandLiveOutputText>[0]) =>
  rawCommandLiveOutputText(output, messages);

describe("timeline presentation", () => {
  it("shows thinking immediately and stops it when the final answer starts", () => {
    expect(thinkingPresentation("inProgress", false, false)).toBe("standalone");
    expect(thinkingPresentation("inProgress", false, true)).toBe("activity");
    expect(thinkingPresentation("inProgress", true, false)).toBe("none");
    expect(thinkingPresentation("completed", false, false)).toBe("none");
  });

  it("uses the official running and completed turn semantics", () => {
    expect(turnDurationLabel("inProgress", "18 min 15 s")).toBe("Processando há 18 min 15 s");
    expect(turnDurationLabel("completed", "18 min 15 s")).toBe("Trabalhou por 18 min 15 s");
  });

  it("formats only safe provider-confirmed output token counts", () => {
    expect(confirmedOutputTokenLabel(1)).toBe("↑ 1 token");
    expect(confirmedOutputTokenLabel(1_234)).toBe("↑ 1.234 tokens");
    expect(() => confirmedOutputTokenLabel(-1)).toThrow(RangeError);
  });

  it("keeps second-level precision for minute and hour durations", () => {
    expect(formatElapsedSeconds(0)).toBe("0 s");
    expect(formatElapsedSeconds(59.9)).toBe("59 s");
    expect(formatElapsedSeconds(60)).toBe("1 min 0 s");
    expect(formatElapsedSeconds(3_599)).toBe("59 min 59 s");
    expect(formatElapsedSeconds(3_600)).toBe("1 h 0 min 0 s");
    expect(formatElapsedSeconds(5_365)).toBe("1 h 29 min 25 s");
  });

  it("uses compact precision in the running-command headline", () => {
    expect(formatCompactElapsedSeconds(59.9)).toBe("59s");
    expect(formatCompactElapsedSeconds(385)).toBe("6m 25s");
    expect(formatCompactElapsedSeconds(5_365)).toBe("1h 29m 25s");
    expect(runningCommandHeadline("6m 25s", "Executando comando")).toBe(
      "Comando em execução há 6m 25s",
    );
    expect(runningCommandHeadline(null, "Executando comando")).toBe("Executando comando");
  });

  it("changes streamed reasoning only at complete semantic section boundaries", () => {
    expect(reasoningTitle(["Investigating remounts"], "streaming")).toBeNull();
    expect(reasoningTitle(["**Designing stable rende"], "streaming")).toBeNull();
    expect(reasoningTitle(["**Planning verification**\n\nInspecting files"], "streaming")).toBe(
      "Planning verification",
    );
    expect(
      reasoningTitle(
        ["**Planning verification**\n\nInspecting files", "**Running focused"],
        "streaming",
      ),
    ).toBe("Planning verification");
    expect(
      reasoningTitle(
        [
          "**Planning verification**\n\nInspecting files",
          "**Running focused checks**\n\nExecuting the suite",
        ],
        "streaming",
      ),
    ).toBe("Running focused checks");
  });

  it("uses stable plain summaries only after their item completes", () => {
    expect(reasoningTitle(["Investigating remounts"], "completed")).toBe("Investigating remounts");
    expect(reasoningTitle(["# Reviewing   final output"], "completed")).toBe(
      "Reviewing final output",
    );
    expect(reasoningTitle([], "completed")).toBeNull();
  });

  it("changes an expanded command title according to its live state", () => {
    expect(commandActivityTitle("rg --files src", "completed", false)).toBe(
      "Executou rg --files src",
    );
    expect(commandActivityTitle("rg --files src", "completed", true)).toBe("Comando executado");
    expect(commandActivityTitle("rg --files src", "inProgress", false)).toBe("Comando em execução");
    expect(commandActivityTitle("rg --files src", "inProgress", true)).toBe("Executando comando");
    expect(toolActivityTitle("Validar interface", "inProgress", false)).toBe("Validar interface");
  });

  it("reveals the command text only after execution reaches a terminal state", () => {
    expect(commandHeadline("pnpm verify", "inProgress", false, "1m 31s")).toBe(
      "Comando em execução há 1m 31s",
    );
    expect(commandHeadline("pnpm verify", "inProgress", false, null)).toBe("Comando em execução");
    expect(commandHeadline("pnpm verify", "completed", false, "1m 32s")).toBe(
      "Executou pnpm verify",
    );
    expect(shouldShowCommandDurationSuffix("inProgress")).toBe(false);
    expect(shouldShowCommandDurationSuffix("completed")).toBe(true);
  });

  it("uses the official chat-terminal labels for stored output reads", () => {
    expect(terminalReadActivityTitle("inProgress")).toBe("Lendo terminal do chat");
    expect(terminalReadActivityTitle("completed")).toBe("Terminal do chat lido");
    expect(terminalReadActivityTitle("failed")).toBe("Falha ao ler o terminal do chat");
  });

  it("formats file reads from execution state and known cardinality", () => {
    expect(fileReadActivityTitle("completed")).toBe("Leu arquivo");
    expect(fileReadActivityTitle("completed", 1)).toBe("Leu um arquivo");
    expect(fileReadActivityTitle("completed", 2)).toBe("Leu arquivos");
    expect(fileReadActivityTitle("completed", 3)).toBe("Leu arquivos");
    expect(fileReadItemTitle("completed", "RULES.md")).toBe("Leu arquivo RULES.md");
    expect(fileReadItemTitle("failed", "RULES.md")).toBe("Falha ao ler arquivo: RULES.md");
    expect(fileReadActivityTitle("inProgress")).toBe("Lendo arquivo");
    expect(fileReadActivityTitle("inProgress", 1)).toBe("Lendo um arquivo");
    expect(fileReadActivityTitle("inProgress", 2)).toBe("Lendo 2 arquivos");
    expect(fileReadActivityTitle("failed", 2)).toBe("Falha ao ler 2 arquivos");
    expect(fileReadActivityTitle("declined", 1)).toBe("Leitura de um arquivo recusada");
    expect(() => fileReadActivityTitle("completed", 0)).toThrow(RangeError);
    expect(() => fileReadActivityTitle("completed", 1.5)).toThrow(RangeError);
  });

  it("uses explicit command polling labels", () => {
    expect(commandPollActivityTitle("inProgress")).toBe("Verificando comando");
    expect(commandPollActivityTitle("completed")).toBe("Comando verificado");
    expect(commandPollActivityTitle("failed")).toBe("Falha ao verificar comando");
  });

  it("shows command duration only after the long-running threshold", () => {
    expect(visibleCommandDurationMs("inProgress", 1_000, null, 10_999)).toBeNull();
    expect(visibleCommandDurationMs("inProgress", 1_000, null, 11_000)).toBe(10_000);
    expect(visibleCommandDurationMs("completed", 1_000, 9_999, 50_000)).toBeNull();
    expect(visibleCommandDurationMs("completed", 1_000, 10_000, 50_000)).toBe(10_000);
  });

  it("summarizes standalone file collections with correct grammar", () => {
    expect(fileChangeGroupTitle(1)).toBe("1 arquivo alterado");
    expect(fileChangeGroupTitle(2)).toBe("2 arquivos alterados");
    expect(fileChangeGroupTitle(4)).toBe("4 arquivos alterados");
  });

  it("labels each file change before its file name", () => {
    expect(fileChangeActionLabel("update")).toBe("Arquivo editado");
    expect(fileChangeActionLabel("add")).toBe("Arquivo criado");
    expect(fileChangeActionLabel("delete")).toBe("Arquivo excluído");
  });

  it("presents command stdout without leaking the provider envelope", () => {
    expect(commandOutputText("exit_code: 0\nstdout:\nsrc/App.tsx\nsrc/main.tsx\n\nstderr:\n")).toBe(
      "src/App.tsx\nsrc/main.tsx",
    );
    expect(commandOutputText("exit_code: 0\nstdout:\npartial page")).toBe("partial page");
    expect(commandOutputText("raw output")).toBe("raw output");
    expect(commandOutputText(undefined)).toBeNull();
    expect(toolOutputText(undefined)).toBeNull();
    expect(toolOutputText("resultado")).toBe("resultado");
  });

  it("presents live stdout and stderr before the final output exists", () => {
    expect(
      commandLiveOutputText({
        stdout: "transforming...\n",
        stderr: "warning\n",
        truncated: true,
      }),
    ).toBe(
      "stdout:\ntransforming...\n\nstderr:\nwarning\n\n[Prévia ao vivo limitada; a saída completa estará disponível ao concluir.]",
    );
    expect(commandLiveOutputText({ stdout: "", stderr: "", truncated: false })).toBeNull();
  });

  it("keeps navigation marks equal until pointer or keyboard interaction", () => {
    expect([0, 1, 2, 3].map((index) => userMessageMarkerWidth(index, null))).toEqual([7, 7, 7, 7]);
    expect([0, 1, 2, 3, 4, 5, 6].map((index) => userMessageMarkerWidth(index, 3))).toEqual([
      10, 14, 20, 25, 20, 14, 10,
    ]);
  });
});
