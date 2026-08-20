import { describe, expect, it } from "vitest";

import { decodeEngineNotification, decodeEngineStartResponse } from "./decode";
import engineStartFixture from "./fixtures/engine-start.json";
import notificationsFixture from "./fixtures/notifications.json";

const NOTIFICATION_METHODS: readonly string[] = [
  "auth.loginCompleted",
  "auth.sessionChanged",
  "thread.created",
  "thread.updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "turn.started",
  "turn.completed",
  "item.streamDeltas",
  "model.rerouted",
  "model.verification",
  "model.safetyBufferingUpdated",
  "automation.changed",
  "automation.deleted",
  "automation.runUpdated",
];

const ITEM_PAYLOAD_TYPES: readonly string[] = [
  "contextUsage",
  "contextCompaction",
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "toolExecution",
];

describe("golden contract fixtures gerados pelo engine Rust", () => {
  it("decodifica o payload de inicialização do engine", () => {
    const response = decodeEngineStartResponse(engineStartFixture);

    expect(response.schemaVersion).toBe(11);
    expect(response.engine.id).toBe("native-engine");
    expect(response.engine.capabilities).toContain("scheduledAutomations");
    expect(response.config.config.desktop.uiFontSize).toBe(15);
    expect(response.config.config.modelContextWindowPreferences["gpt-5.6-codex"]).toBe("maximum");
    expect(response.permissionProfiles).toHaveLength(3);
  });

  it("decodifica cada notificação do contrato sem rejeitar campos", () => {
    const entries = notificationsFixture as readonly unknown[];

    expect(entries.map((entry) => decodeEngineNotification(entry).method)).toEqual([
      ...NOTIFICATION_METHODS,
      ...ITEM_PAYLOAD_TYPES.map(() => "item.completed"),
    ]);
  });

  it("decodifica cada variante de item de conversa", () => {
    const entries = notificationsFixture as readonly unknown[];
    const itemTypes = entries
      .map((entry) => decodeEngineNotification(entry))
      .filter((notification) => notification.method === "item.completed")
      .map((notification) => {
        if (notification.method !== "item.completed") {
          throw new Error("filtro inconsistente no teste de fixtures");
        }
        return notification.params.item.type;
      });

    expect(itemTypes).toEqual(ITEM_PAYLOAD_TYPES);
  });
});
