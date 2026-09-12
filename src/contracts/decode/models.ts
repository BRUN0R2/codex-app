import type {
  ChatModelListResponse,
  ChatModelOption,
  CodexModel,
  ModelContextWindow,
  ModelContextWindowPreference,
  ModelListResponse,
  ModelRuntimeCapability,
  ModelServiceTier,
  ReasoningEffort,
  ReasoningEffortOption,
} from "../types";
import {
  CHAT_MODEL_LANES,
  CHAT_THINKING_EFFORTS,
  MODEL_RUNTIME_CAPABILITIES,
  REASONING_EFFORTS,
  STORED_MODEL_CONTEXT_WINDOW_PREFERENCES,
} from "./constants";
import {
  array,
  booleanValue,
  ContractError,
  exactRecord,
  identifier,
  integer,
  literal,
  nullableText,
  record,
  text,
} from "./primitives";

export function decodeModelListResponse(value: unknown): ModelListResponse {
  const object = exactRecord(value, "$", ["data"]);
  const data = array(object.data, "$.data", decodeModel, 100);
  if (data.length === 0) {
    throw new ContractError("$.data", "model catalog cannot be empty");
  }
  const identifiers = new Set<string>();
  for (const model of data) {
    if (identifiers.has(model.id)) {
      throw new ContractError("$.data", `duplicate model id ${JSON.stringify(model.id)}`);
    }
    identifiers.add(model.id);
  }
  const defaults = data.filter((model) => model.isDefault);
  if (
    defaults.length !== 1 ||
    defaults[0]?.hidden === true ||
    (defaults[0]?.defaultReasoningEffort !== null &&
      defaults[0]?.unsupportedReasoningEfforts.includes(defaults[0].defaultReasoningEffort) ===
        true)
  ) {
    throw new ContractError(
      "$.data",
      "model catalog must contain one visible runtime-compatible default model",
    );
  }
  return { data };
}

export function decodeChatModelListResponse(value: unknown): ChatModelListResponse {
  const object = exactRecord(value, "$", ["data"]);
  const data = array(object.data, "$.data", decodeChatModelOption, 100);
  if (data.length === 0) {
    throw new ContractError("$.data", "ChatGPT model catalog cannot be empty");
  }
  const identifiers = new Set<string>();
  for (const model of data) {
    if (identifiers.has(model.id)) {
      throw new ContractError(
        "$.data",
        `duplicate ChatGPT model option ${JSON.stringify(model.id)}`,
      );
    }
    identifiers.add(model.id);
  }
  if (data.filter((model) => model.isDefault).length !== 1) {
    throw new ContractError("$.data", "ChatGPT model catalog must have exactly one default option");
  }
  return { data };
}

export function decodeModel(value: unknown, path: string): CodexModel {
  const object = exactRecord(value, path, [
    "defaultReasoningEffort",
    "defaultServiceTier",
    "description",
    "displayName",
    "hidden",
    "id",
    "isDefault",
    "model",
    "contextWindow",
    "serviceTiers",
    "supportedReasoningEfforts",
    "unsupportedRuntimeCapabilities",
    "unsupportedReasoningEfforts",
  ]);
  const id = identifier(object.id, `${path}.id`);
  const model = identifier(object.model, `${path}.model`);
  if (model !== id) {
    throw new ContractError(`${path}.model`, "must equal the canonical model id");
  }
  const supportedReasoningEfforts = array(
    object.supportedReasoningEfforts,
    `${path}.supportedReasoningEfforts`,
    decodeReasoningOption,
    32,
  );
  const reasoningEffortNames = new Set(
    supportedReasoningEfforts.map((option) => option.reasoningEffort),
  );
  if (reasoningEffortNames.size !== supportedReasoningEfforts.length) {
    throw new ContractError(
      `${path}.supportedReasoningEfforts`,
      "must contain unique reasoning efforts",
    );
  }
  const defaultReasoningEffort =
    object.defaultReasoningEffort === null
      ? null
      : literal(object.defaultReasoningEffort, `${path}.defaultReasoningEffort`, REASONING_EFFORTS);
  if (defaultReasoningEffort !== null && !reasoningEffortNames.has(defaultReasoningEffort)) {
    throw new ContractError(
      `${path}.defaultReasoningEffort`,
      "must be one of the supported reasoning efforts",
    );
  }
  const serviceTiers = array(object.serviceTiers, `${path}.serviceTiers`, decodeServiceTier, 32);
  const serviceTierIds = new Set(serviceTiers.map((tier) => tier.id));
  if (serviceTierIds.size !== serviceTiers.length) {
    throw new ContractError(`${path}.serviceTiers`, "must contain unique service tier ids");
  }
  const defaultServiceTier = nullableText(object.defaultServiceTier, `${path}.defaultServiceTier`);
  if (defaultServiceTier !== null && !serviceTierIds.has(defaultServiceTier)) {
    throw new ContractError(
      `${path}.defaultServiceTier`,
      "must be one of the advertised service tiers",
    );
  }
  const unsupportedRuntimeCapabilities = array(
    object.unsupportedRuntimeCapabilities,
    `${path}.unsupportedRuntimeCapabilities`,
    (value, capabilityPath): ModelRuntimeCapability =>
      literal(value, capabilityPath, MODEL_RUNTIME_CAPABILITIES),
    MODEL_RUNTIME_CAPABILITIES.length,
  );
  if (new Set(unsupportedRuntimeCapabilities).size !== unsupportedRuntimeCapabilities.length) {
    throw new ContractError(
      `${path}.unsupportedRuntimeCapabilities`,
      "must contain unique runtime capabilities",
    );
  }
  const unsupportedReasoningEfforts = array(
    object.unsupportedReasoningEfforts,
    `${path}.unsupportedReasoningEfforts`,
    (value, effortPath): ReasoningEffort => literal(value, effortPath, REASONING_EFFORTS),
    REASONING_EFFORTS.length,
  );
  const unsupportedReasoningEffortNames = new Set(unsupportedReasoningEfforts);
  if (
    unsupportedReasoningEffortNames.size !== unsupportedReasoningEfforts.length ||
    unsupportedReasoningEfforts.some((effort) => !reasoningEffortNames.has(effort))
  ) {
    throw new ContractError(
      `${path}.unsupportedReasoningEfforts`,
      "must contain unique advertised reasoning efforts",
    );
  }
  return {
    id,
    model,
    displayName: text(object.displayName, `${path}.displayName`),
    description:
      object.description === null
        ? null
        : text(object.description, `${path}.description`, 16_384, true),
    hidden: booleanValue(object.hidden, `${path}.hidden`),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    serviceTiers,
    defaultServiceTier,
    contextWindow:
      object.contextWindow === null
        ? null
        : decodeModelContextWindow(object.contextWindow, `${path}.contextWindow`),
    unsupportedRuntimeCapabilities,
    unsupportedReasoningEfforts,
    isDefault: booleanValue(object.isDefault, `${path}.isDefault`),
  };
}

export function decodeChatModelOption(value: unknown, path: string): ChatModelOption {
  const object = exactRecord(value, path, [
    "description",
    "id",
    "isDefault",
    "lane",
    "model",
    "selectedLabel",
    "thinkingEffort",
    "title",
    "versionId",
  ]);
  return {
    id: identifier(object.id, `${path}.id`),
    model: identifier(object.model, `${path}.model`),
    title: text(object.title, `${path}.title`, 16_384),
    description:
      object.description === null
        ? null
        : text(object.description, `${path}.description`, 16_384, true),
    lane: object.lane === null ? null : literal(object.lane, `${path}.lane`, CHAT_MODEL_LANES),
    thinkingEffort:
      object.thinkingEffort === null
        ? null
        : literal(object.thinkingEffort, `${path}.thinkingEffort`, CHAT_THINKING_EFFORTS),
    versionId: object.versionId === null ? null : identifier(object.versionId, `${path}.versionId`),
    selectedLabel:
      object.selectedLabel === null
        ? null
        : text(object.selectedLabel, `${path}.selectedLabel`, 16_384),
    isDefault: booleanValue(object.isDefault, `${path}.isDefault`),
  };
}

export function decodeModelContextWindow(value: unknown, path: string): ModelContextWindow {
  const object = exactRecord(value, path, [
    "maximumTokens",
    "tokens",
    "usablePercent",
    "usableTokens",
  ]);
  const tokens = integer(object.tokens, `${path}.tokens`, 1, 1_000_000_000);
  const usablePercent = integer(object.usablePercent, `${path}.usablePercent`, 1, 100);
  const usableTokens = integer(object.usableTokens, `${path}.usableTokens`, 1, tokens);
  const expectedUsableTokens = Math.floor((tokens * usablePercent) / 100);
  if (usableTokens !== expectedUsableTokens) {
    throw new ContractError(`${path}.usableTokens`, "does not match tokens and usablePercent");
  }
  const maximumTokens =
    object.maximumTokens === null
      ? null
      : integer(object.maximumTokens, `${path}.maximumTokens`, tokens, 1_000_000_000);
  return { tokens, usableTokens, usablePercent, maximumTokens };
}

export function decodeReasoningOption(value: unknown, path: string): ReasoningEffortOption {
  const object = exactRecord(value, path, ["description", "reasoningEffort"]);
  return {
    reasoningEffort: literal(object.reasoningEffort, `${path}.reasoningEffort`, REASONING_EFFORTS),
    description: text(object.description, `${path}.description`, 16_384, true),
  };
}

export function decodeServiceTier(value: unknown, path: string): ModelServiceTier {
  const object = exactRecord(value, path, ["description", "id", "name"]);
  return {
    id: identifier(object.id, `${path}.id`),
    name: text(object.name, `${path}.name`),
    description: text(object.description, `${path}.description`, 16_384, true),
  };
}

export function decodeModelContextWindowPreferences(
  value: unknown,
  path: string,
): Readonly<Record<string, ModelContextWindowPreference>> {
  const object = record(value, path);
  const entries = Object.entries(object);
  if (entries.length > 128) {
    throw new ContractError(path, "map exceeds 128 entries");
  }
  return Object.fromEntries(
    entries.map(([model, preference]) => [
      identifier(model, `${path}.${model}`),
      literal(preference, `${path}.${model}`, STORED_MODEL_CONTEXT_WINDOW_PREFERENCES),
    ]),
  );
}
