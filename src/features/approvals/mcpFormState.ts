import type { McpFormField } from "./serverRequestTypes";

export type FormDraft = boolean | null | string | string[];

export function initialFormDrafts(
  fields: McpFormField[],
): Record<string, FormDraft> {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.type === "number"
        ? field.defaultValue === null
          ? ""
          : String(field.defaultValue)
        : field.defaultValue,
    ]),
  );
}

export function buildFormContent(
  fields: McpFormField[],
  drafts: Record<string, FormDraft>,
):
  | { ok: true; value: Record<string, boolean | number | string | string[]> }
  | { ok: false; error: string } {
  const content: Record<string, boolean | number | string | string[]> = {};
  for (const field of fields) {
    const value = drafts[field.name];
    if (field.type === "text") {
      const text = typeof value === "string" ? value : "";
      const error = validateText(field, text);
      if (error !== null) {
        return { ok: false, error };
      }
      if (text.length > 0) {
        content[field.name] = text;
      }
      continue;
    }
    if (field.type === "number") {
      const raw = typeof value === "string" ? value.trim() : "";
      if (raw.length === 0 && !field.required) {
        continue;
      }
      const number = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(number) ||
        (field.integer && !Number.isSafeInteger(number)) ||
        (field.minimum !== null && number < field.minimum) ||
        (field.maximum !== null && number > field.maximum)
      ) {
        return { ok: false, error: `Revise o valor de “${field.label}”.` };
      }
      content[field.name] = number;
      continue;
    }
    if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        if (field.required) {
          return { ok: false, error: `Responda “${field.label}”.` };
        }
      } else {
        content[field.name] = value;
      }
      continue;
    }
    if (field.multiple) {
      const values = Array.isArray(value) ? value : [];
      if (
        new Set(values).size !== values.length ||
        values.some(
          (selected) => !field.options.some((option) => option.value === selected),
        ) ||
        (field.required && values.length === 0) ||
        (field.minimumSelections !== null && values.length < field.minimumSelections) ||
        (field.maximumSelections !== null && values.length > field.maximumSelections)
      ) {
        return { ok: false, error: `Revise as opções de “${field.label}”.` };
      }
      if (values.length > 0) {
        content[field.name] = values;
      }
      continue;
    }
    const selected = typeof value === "string" ? value : "";
    if (
      (selected.length === 0 && field.required) ||
      (selected.length > 0 &&
        !field.options.some((option) => option.value === selected))
    ) {
      return { ok: false, error: `Selecione uma opção válida em “${field.label}”.` };
    }
    if (selected.length > 0) {
      content[field.name] = selected;
    }
  }
  return { ok: true, value: content };
}

export function inputType(
  format: Extract<McpFormField, { type: "text" }>["format"],
) {
  switch (format) {
    case "date":
      return "date";
    case "date-time":
      return "datetime-local";
    case "email":
      return "email";
    case "uri":
      return "url";
    case null:
      return "text";
  }
}

export function updateMultiValue(
  current: string[],
  value: string,
  checked: boolean,
): string[] {
  return checked
    ? current.includes(value)
      ? current
      : [...current, value]
    : current.filter((entry) => entry !== value);
}

function validateText(
  field: Extract<McpFormField, { type: "text" }>,
  value: string,
): string | null {
  if (field.required && value.trim().length === 0) {
    return `Preencha “${field.label}”.`;
  }
  if (!field.required && value.length === 0) {
    return null;
  }
  if (
    (field.minimumLength !== null && value.length < field.minimumLength) ||
    (field.maximumLength !== null && value.length > field.maximumLength)
  ) {
    return `Revise o tamanho de “${field.label}”.`;
  }
  if (value.length === 0 || field.format === null) {
    return null;
  }
  if (field.format === "uri") {
    try {
      new URL(value);
      return null;
    } catch {
      return `Informe uma URL válida em “${field.label}”.`;
    }
  }
  if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `Informe um e-mail válido em “${field.label}”.`;
  }
  return null;
}
