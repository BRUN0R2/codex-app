import type englishCatalogSource from "./locales/en.json";

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/gu;

export type TranslationMessages = typeof englishCatalogSource.messages;

export function formatMessage(
  template: string,
  replacements: Readonly<Record<string, string | number>>,
): string {
  const expected = translationPlaceholders(template);
  const received = Object.keys(replacements).toSorted();
  if (
    expected.length !== received.length ||
    expected.some((key, index) => key !== received[index])
  ) {
    throw new Error(
      `Translation placeholders must be exactly ${expected.join(", ") || "empty"}; received ${received.join(", ") || "empty"}.`,
    );
  }
  return template.replaceAll(PLACEHOLDER_PATTERN, (_match, key: string) =>
    String(replacements[key]),
  );
}

export function translationPlaceholders(message: string): readonly string[] {
  const result = new Set<string>();
  for (const match of message.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1];
    if (key !== undefined) result.add(key);
  }
  return [...result].toSorted();
}
