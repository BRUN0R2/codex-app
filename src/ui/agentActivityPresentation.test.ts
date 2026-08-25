import { describe, expect, it } from "vitest";

import type { FileChange, VisibleThreadItem } from "../contracts/types";
import {
  type AgentActivityItem,
  AgentActivityProjectionStore,
  activeAgentActivity,
  agentActivityRenderUnitIdentity,
  agentActivitySummaryLabel,
  shouldRenderAgentActivityGroup,
  splitAgentActivityUnits,
  summarizeAgentActivity,
  webSearchActivityTitle,
} from "./agentActivityPresentation";

describe("agent activity presentation", () => {
  it("uses the official semantic priority instead of chronological category order", () => {
    const items = [
      command("command-1"),
      fileChange("change-1", "src/App.tsx"),
      command("command-2"),
    ];

    expect(agentActivitySummaryLabel(items)).toBe("Editou um arquivo e executou comandos");
    expect(summarizeAgentActivity(items).map(({ kind }) => kind)).toEqual([
      "fileChanges",
      "commands",
    ]);
  });

  it("combines commands and web searches with the official wording", () => {
    const items = [command("command-1"), command("command-2"), webSearch("search-1")];

    expect(agentActivitySummaryLabel(items)).toBe("Executou comandos e pesquisou na web");
  });

  it("classifies command polling as command activity", () => {
    const items = [tool("poll-1", "poll_command", "Poll command session-1")];

    expect(agentActivitySummaryLabel(items)).toBe("Executou um comando");
    expect(summarizeAgentActivity(items).map(({ kind }) => kind)).toEqual(["commands"]);
  });

  it("presents stored output reads as chat-terminal activity", () => {
    const items = [
      command("command-1"),
      tool("terminal-read-1", "read_output", "Read stored output output-1"),
    ];

    expect(agentActivitySummaryLabel(items)).toBe("Executou um comando e leu o terminal do chat");
    expect(summarizeAgentActivity(items).map(({ kind }) => kind)).toEqual([
      "commands",
      "terminalRead",
    ]);
    expect(
      activeAgentActivity([
        {
          ...tool("terminal-read-2", "read_output", "Read stored output output-2"),
          status: "inProgress",
        },
      ]),
    ).toEqual({ kind: "terminalRead", label: "Lendo terminal do chat" });
  });

  it("joins all supported categories in a concise Portuguese list", () => {
    const items = [
      tool("tool-1", "custom_tool"),
      fileChange("change-1", "src/App.tsx"),
      tool("read-1", "read_file"),
      command("command-1"),
      webSearch("search-1"),
    ];

    expect(agentActivitySummaryLabel(items)).toBe(
      "Chamou uma ferramenta, editou um arquivo, executou leitura de um arquivo, executou um comando e pesquisou na web",
    );
  });

  it("counts file reads independently and reports concurrent reads in progress", () => {
    const completed = [
      tool("read-1", "read_file"),
      tool("read-2", "read_file"),
      tool("search-1", "search_text"),
    ];
    const running = completed.slice(0, 2).map((item) => ({
      ...item,
      status: "inProgress" as const,
    }));

    expect(agentActivitySummaryLabel(completed)).toBe(
      "Executou leitura de 2 arquivos e explorou arquivos",
    );
    expect(summarizeAgentActivity(completed).map(({ kind }) => kind)).toEqual([
      "fileReads",
      "exploration",
    ]);
    expect(activeAgentActivity(running)).toEqual({
      kind: "fileReads",
      label: "Lendo 2 arquivos",
    });
  });

  it("projects consecutive image views as the official dedicated image group", () => {
    const units = splitAgentActivityUnits([
      command("command-1"),
      webSearch("search-1"),
      tool("image-1", "view_image"),
      tool("image-2", "view_image"),
      command("command-2"),
    ]);

    expect(units.map(({ kind }) => kind)).toEqual(["activityGroup", "imageView", "activityGroup"]);
    expect(units[0]?.kind === "activityGroup" ? units[0].items.map(({ id }) => id) : []).toEqual([
      "command-1",
      "search-1",
    ]);
    expect(units[1]?.kind === "imageView" ? units[1].items.map(({ id }) => id) : []).toEqual([
      "image-1",
      "image-2",
    ]);
    expect(units[2]?.kind === "activityGroup" ? units[2].items.map(({ id }) => id) : []).toEqual([
      "command-2",
    ]);
  });

  it("keeps reasoning out of the rendered trace without splitting adjacent activity", () => {
    const units = splitAgentActivityUnits([
      command("command-1"),
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Validando a implementação"],
        content: [],
      },
      webSearch("search-1"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.kind === "activityGroup" ? units[0].items.map(({ id }) => id) : []).toEqual([
      "command-1",
      "search-1",
    ]);
  });

  it("keeps a group's identity stable when new activities are appended", () => {
    const initial = splitAgentActivityUnits([command("command-1"), command("command-2")]);
    const withCommand = splitAgentActivityUnits([
      command("command-1"),
      command("command-2"),
      command("command-3"),
    ]);
    const withFileChange = splitAgentActivityUnits([
      command("command-1"),
      command("command-2"),
      fileChange("change-1", "src/App.tsx"),
    ]);

    expect(initial[0]?.key).toBe("activity:command-1");
    expect(withCommand[0]?.key).toBe(initial[0]?.key);
    expect(withFileChange[0]?.key).toBe(initial[0]?.key);
  });

  it("preserves projected objects when reasoning changes without changing activity", () => {
    const store = new AgentActivityProjectionStore();
    const firstCommand = command("command-1");
    const secondCommand = command("command-2");
    const initial = store.project([firstCommand, secondCommand]);
    const withReasoning = store.project([
      firstCommand,
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Atualizando análise"],
        content: [],
      },
      secondCommand,
    ]);

    expect(withReasoning).toBe(initial);
    expect(withReasoning[0]).toBe(initial[0]);
  });

  it("keeps semantic identity while replacing only a changed activity unit", () => {
    const store = new AgentActivityProjectionStore();
    const firstCommand = command("command-1");
    const initial = store.project([firstCommand]);
    const completed = store.project([{ ...firstCommand, durationMs: 20 }]);

    expect(completed).not.toBe(initial);
    expect(completed[0]).not.toBe(initial[0]);
    expect(completed[0] === undefined ? null : agentActivityRenderUnitIdentity(completed[0])).toBe(
      initial[0] === undefined ? null : agentActivityRenderUnitIdentity(initial[0]),
    );
  });

  it("groups a lone activity only while it owns the current heading", () => {
    const single = splitAgentActivityUnits([command("command-1")]);
    const singleFileChange = splitAgentActivityUnits([fileChange("change-1", "src/App.tsx")]);
    const multipleChanges = splitAgentActivityUnits([
      fileChange("change-1", "src/App.tsx", {
        path: "src/main.tsx",
        kind: { type: "add" },
        diff: "+export {};",
        lineStats: { additions: 1, deletions: 0 },
      }),
    ]);

    expect(single[0]?.kind).toBe("activityGroup");
    expect(
      single[0]?.kind === "activityGroup"
        ? shouldRenderAgentActivityGroup(single[0].items, false)
        : true,
    ).toBe(false);
    expect(
      single[0]?.kind === "activityGroup"
        ? shouldRenderAgentActivityGroup(single[0].items, true)
        : false,
    ).toBe(true);
    expect(
      singleFileChange[0]?.kind === "activityGroup"
        ? shouldRenderAgentActivityGroup(singleFileChange[0].items, false)
        : true,
    ).toBe(false);
    expect(
      singleFileChange[0]?.kind === "activityGroup"
        ? shouldRenderAgentActivityGroup(singleFileChange[0].items, true)
        : false,
    ).toBe(true);
    expect(
      multipleChanges[0]?.kind === "activityGroup"
        ? shouldRenderAgentActivityGroup(multipleChanges[0].items, false)
        : false,
    ).toBe(true);
  });

  it("uses a concise active label for the latest running activity", () => {
    expect(activeAgentActivity([{ ...command("command-1"), status: "inProgress" }])).toEqual({
      kind: "commands",
      label: "Executando comando",
    });
    expect(
      activeAgentActivity([
        { ...webSearch("search-1"), status: "inProgress", description: "documentação Codex" },
      ]),
    ).toEqual({ kind: "webSearch", label: "Pesquisando na web por documentação Codex" });
  });

  it("presents web searches as semantic activity rows", () => {
    expect(webSearchActivityTitle("Codex app activity messages", "completed")).toBe(
      "Pesquisou na web por Codex app activity messages",
    );
    expect(webSearchActivityTitle("https://developers.openai.com/codex/app/", "completed")).toBe(
      "Pesquisou na web por https://developers.openai.com/codex/app/",
    );
    expect(webSearchActivityTitle("Web search", "inProgress")).toBe("Pesquisando na web");
  });
});

function command(id: string): Extract<AgentActivityItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id,
    command: "rtk rg --files",
    cwd: "C:\\repo",
    processId: null,
    startedAt: null,
    source: "agent",
    status: "completed",
    aggregatedOutput: null,
    liveOutput: null,
    exitCode: 0,
    durationMs: 1,
  };
}

function fileChange(
  id: string,
  path: string,
  extra?: FileChange,
): Extract<AgentActivityItem, { type: "fileChange" }> {
  return {
    type: "fileChange",
    id,
    status: "completed",
    changes: [
      {
        path,
        kind: { type: "update", movePath: null },
        diff: "-old\n+new",
        lineStats: { additions: 1, deletions: 1 },
      },
      ...(extra === undefined ? [] : [extra]),
    ],
  };
}

function webSearch(id: string): Extract<AgentActivityItem, { type: "toolExecution" }> {
  return tool(id, "web_search", "Codex app activity messages");
}

function tool(
  id: string,
  name: string,
  description = "Ferramenta",
): Extract<VisibleThreadItem, { type: "toolExecution" }> {
  return {
    type: "toolExecution",
    id,
    name,
    description,
    status: "completed",
    outputPresentation: { type: "plainText" },
    output: null,
  };
}
