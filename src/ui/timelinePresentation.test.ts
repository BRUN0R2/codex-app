import { describe, expect, it } from "vitest";

import {
  commandActivityTitle,
  commandLiveOutputText,
  commandOutputText,
  commandPollActivityTitle,
  fileChangeActionLabel,
  fileChangeGroupTitle,
  formatCompactElapsedSeconds,
  formatElapsedSeconds,
  reasoningTitle,
  runningCommandHeadline,
  terminalReadActivityTitle,
  thinkingPresentation,
  toolActivityTitle,
  toolOutputText,
  turnDurationLabel,
  userMessageMarkerWidth,
  visibleCommandDurationMs,
} from "./timelinePresentation";

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

  it("uses the latest streamed reasoning heading without exposing completed markdown", () => {
    expect(reasoningTitle(["Investigating remounts"], [])).toBe("Investigating remounts");
    expect(reasoningTitle(["Earlier", "**Designing stable render with <Index>**"], [])).toBe(
      "Designing stable render with <Index>",
    );
    expect(reasoningTitle(["**Designing stable rende"], [])).toBe("**Designing stable rende");
  });

  it("changes an expanded command title according to its live state", () => {
    expect(commandActivityTitle("rg --files src", "completed", false)).toBe(
      "Comando executado: rg --files src",
    );
    expect(commandActivityTitle("rg --files src", "completed", true)).toBe("Comando executado");
    expect(commandActivityTitle("rg --files src", "inProgress", false)).toBe(
      "Executando comando: rg --files src",
    );
    expect(commandActivityTitle("rg --files src", "inProgress", true)).toBe("Executando comando");
    expect(toolActivityTitle("Validar interface", "inProgress", false)).toBe("Validar interface");
  });

  it("uses the official chat-terminal labels for stored output reads", () => {
    expect(terminalReadActivityTitle("inProgress")).toBe("Lendo terminal do chat");
    expect(terminalReadActivityTitle("completed")).toBe("Terminal do chat lido");
    expect(terminalReadActivityTitle("failed")).toBe("Falha ao ler o terminal do chat");
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
