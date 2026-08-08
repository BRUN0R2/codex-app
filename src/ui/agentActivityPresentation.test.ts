import { describe, expect, it } from "vitest";

import type { FileChange, VisibleThreadItem } from "../contracts/types";
import {
  type AgentActivityItem,
  activeAgentActivity,
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

  it("joins all supported categories in a concise Portuguese list", () => {
    const items = [
      tool("tool-1", "custom_tool"),
      fileChange("change-1", "src/App.tsx"),
      tool("read-1", "read_file"),
      command("command-1"),
      webSearch("search-1"),
    ];

    expect(agentActivitySummaryLabel(items)).toBe(
      "Chamou uma ferramenta, editou um arquivo, leu arquivos, executou um comando e pesquisou na web",
    );
  });

  it("groups only meaningful activity runs and keeps image results standalone", () => {
    const image = tool("image-1", "view_image");
    const units = splitAgentActivityUnits([
      command("command-1"),
      webSearch("search-1"),
      image,
      command("command-2"),
    ]);

    expect(units.map(({ kind }) => kind)).toEqual(["activityGroup", "item", "activityGroup"]);
    expect(units[0]?.kind === "activityGroup" ? units[0].items.map(({ id }) => id) : []).toEqual([
      "command-1",
      "search-1",
    ]);
    expect(units[1]).toEqual({ kind: "item", key: "image-1", item: image });
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

  it("only keeps a lone completed row grouped while it owns the current activity heading", () => {
    const single = splitAgentActivityUnits([command("command-1")]);
    const multipleChanges = splitAgentActivityUnits([
      fileChange("change-1", "src/App.tsx", {
        path: "src/main.tsx",
        kind: { type: "add" },
        diff: "+export {};",
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
    source: "agent",
    status: "completed",
    aggregatedOutput: null,
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
    output: null,
  };
}
