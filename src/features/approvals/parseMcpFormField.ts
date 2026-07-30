import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  decoded,
  isFiniteInteger,
  rejected,
  type DecodeResult,
} from "./requestParsing";
import type {
  McpFormField,
  McpFormStringFormat,
} from "./serverRequestTypes";

interface McpFieldBase {
  description: string | null;
  label: string;
  name: string;
  required: boolean;
}

export function parseMcpFormField(
  name: string,
  value: JsonValue,
  required: boolean,
): DecodeResult<McpFormField> {
  if (!isJsonObject(value)) {
    return rejected(`o campo ${name} não contém um esquema válido`);
  }
  const base = parseFieldBase(name, value, required);
  if (!base.ok) {
    return base;
  }
  if (value.type === "string" && (Array.isArray(value.enum) || Array.isArray(value.oneOf))) {
    return parseSingleSelect(base.value, value);
  }
  switch (value.type) {
    case "string":
      return parseTextField(base.value, value);
    case "number":
    case "integer":
      return parseNumberField(base.value, value);
    case "boolean":
      return parseBooleanField(base.value, value);
    case "array":
      return parseMultiSelect(base.value, value);
    default:
      return rejected(`o campo ${name} usa um tipo não suportado`);
  }
}

function parseFieldBase(
  name: string,
  schema: JsonObject,
  required: boolean,
): DecodeResult<McpFieldBase> {
  if (
    (schema.title !== undefined && typeof schema.title !== "string") ||
    (schema.description !== undefined && typeof schema.description !== "string")
  ) {
    return rejected(`o campo ${name} contém título ou descrição inválida`);
  }
  return decoded({
    name,
    label: typeof schema.title === "string" ? schema.title : humanize(name),
    description: typeof schema.description === "string" ? schema.description : null,
    required,
  });
}

function parseTextField(
  base: McpFieldBase,
  schema: JsonObject,
): DecodeResult<McpFormField> {
  const minimum = optionalNonNegativeInteger(schema.minLength);
  const maximum = optionalNonNegativeInteger(schema.maxLength);
  if (
    minimum === "invalid" ||
    maximum === "invalid" ||
    (schema.default !== undefined && typeof schema.default !== "string") ||
    !isStringFormat(schema.format) ||
    (minimum !== null && maximum !== null && minimum > maximum)
  ) {
    return rejected(`o campo ${base.name} contém limites, formato ou padrão inválido`);
  }
  return decoded({
    ...base,
    type: "text",
    defaultValue: typeof schema.default === "string" ? schema.default : null,
    format: isStringFormat(schema.format) ? (schema.format ?? null) : null,
    minimumLength: minimum,
    maximumLength: maximum,
  });
}

function parseNumberField(
  base: McpFieldBase,
  schema: JsonObject,
): DecodeResult<McpFormField> {
  const minimum = optionalFiniteNumber(schema.minimum);
  const maximum = optionalFiniteNumber(schema.maximum);
  const defaultValue = optionalFiniteNumber(schema.default);
  if (
    minimum === "invalid" ||
    maximum === "invalid" ||
    defaultValue === "invalid" ||
    (minimum !== null && maximum !== null && minimum > maximum) ||
    (defaultValue !== null && minimum !== null && defaultValue < minimum) ||
    (defaultValue !== null && maximum !== null && defaultValue > maximum) ||
    (schema.type === "integer" && defaultValue !== null && !Number.isSafeInteger(defaultValue))
  ) {
    return rejected(`o campo ${base.name} contém limites ou padrão numérico inválido`);
  }
  return decoded({
    ...base,
    type: "number",
    integer: schema.type === "integer",
    minimum,
    maximum,
    defaultValue,
  });
}

function parseBooleanField(
  base: McpFieldBase,
  schema: JsonObject,
): DecodeResult<McpFormField> {
  if (schema.default !== undefined && typeof schema.default !== "boolean") {
    return rejected(`o campo ${base.name} contém um padrão booleano inválido`);
  }
  return decoded({
    ...base,
    type: "boolean",
    defaultValue: typeof schema.default === "boolean" ? schema.default : null,
  });
}

function parseSingleSelect(
  base: McpFieldBase,
  schema: JsonObject,
): DecodeResult<McpFormField> {
  const options = parseSelectOptions(schema);
  if (!options.ok) {
    return options;
  }
  if (
    schema.default !== undefined &&
    (typeof schema.default !== "string" ||
      !options.value.some(({ value }) => value === schema.default))
  ) {
    return rejected(`o campo ${base.name} contém uma opção padrão inválida`);
  }
  return decoded({
    ...base,
    type: "select",
    multiple: false,
    options: options.value,
    defaultValue: typeof schema.default === "string" ? schema.default : null,
  });
}

function parseMultiSelect(
  base: McpFieldBase,
  schema: JsonObject,
): DecodeResult<McpFormField> {
  if (!isJsonObject(schema.items)) {
    return rejected(`o campo ${base.name} não contém opções válidas`);
  }
  const options = parseSelectOptions(schema.items);
  const minimum = optionalNonNegativeInteger(schema.minItems);
  const maximum = optionalNonNegativeInteger(schema.maxItems);
  if (!options.ok || minimum === "invalid" || maximum === "invalid") {
    return rejected(`o campo ${base.name} contém opções ou limites inválidos`);
  }
  if (minimum !== null && maximum !== null && minimum > maximum) {
    return rejected(`o campo ${base.name} contém limites invertidos`);
  }
  const defaults = schema.default === undefined ? [] : schema.default;
  if (
    !Array.isArray(defaults) ||
    !defaults.every(
      (entry) =>
        typeof entry === "string" &&
        options.value.some(({ value }) => value === entry),
    )
  ) {
    return rejected(`o campo ${base.name} contém opções padrão inválidas`);
  }
  return decoded({
    ...base,
    type: "select",
    multiple: true,
    options: options.value,
    defaultValue: defaults.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    minimumSelections: minimum,
    maximumSelections: maximum,
  });
}

function parseSelectOptions(
  schema: JsonObject,
): DecodeResult<Array<{ label: string; value: string }>> {
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const candidates = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : [];
    const options: Array<{ label: string; value: string }> = [];
    for (const candidate of candidates) {
      if (
        !isJsonObject(candidate) ||
        typeof candidate.const !== "string" ||
        typeof candidate.title !== "string"
      ) {
        return rejected("uma opção titulada do formulário é inválida");
      }
      options.push({ value: candidate.const, label: candidate.title });
    }
    return uniqueOptions(options);
  }
  if (!Array.isArray(schema.enum) || !schema.enum.every((entry) => typeof entry === "string")) {
    return rejected("as opções do formulário são inválidas");
  }
  const names = schema.enumNames;
  if (
    names !== undefined &&
    (!Array.isArray(names) ||
      !names.every((entry) => typeof entry === "string") ||
      names.length !== schema.enum.length)
  ) {
    return rejected("os títulos das opções do formulário são inválidos");
  }
  return uniqueOptions(
    schema.enum.map((value, index) => ({
      value,
      label: Array.isArray(names) ? (names[index] as string) : value,
    })),
  );
}

function uniqueOptions(
  options: Array<{ label: string; value: string }>,
): DecodeResult<Array<{ label: string; value: string }>> {
  if (options.length === 0 || new Set(options.map(({ value }) => value)).size !== options.length) {
    return rejected("o formulário não contém opções únicas");
  }
  return decoded(options);
}

function isStringFormat(
  value: JsonValue | undefined,
): value is McpFormStringFormat | undefined {
  return (
    value === undefined ||
    value === "email" ||
    value === "uri" ||
    value === "date" ||
    value === "date-time"
  );
}

function optionalFiniteNumber(
  value: JsonValue | undefined,
): number | null | "invalid" {
  return value === undefined
    ? null
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : "invalid";
}

function optionalNonNegativeInteger(
  value: JsonValue | undefined,
): number | null | "invalid" {
  return value === undefined
    ? null
    : isFiniteInteger(value) && value >= 0
      ? value
      : "invalid";
}

function humanize(value: string): string {
  const text = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ");
  return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
