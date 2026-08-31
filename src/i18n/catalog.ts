import { type TranslationMessages, translationPlaceholders } from "./messages";

const DEFAULT_LOCALE = "en";
const MAXIMUM_CATALOG_NAME_CHARACTERS = 80;
const MAXIMUM_MESSAGE_CHARACTERS = 8_192;
export type TextDirection = "ltr" | "rtl";
export type LocaleCode = string & { readonly __localeCode: unique symbol };

export interface TranslationCatalog {
  readonly direction: TextDirection;
  readonly locale: LocaleCode;
  readonly messages: TranslationMessages;
  readonly name: string;
}

type UnknownRecord = Record<string, unknown>;

interface TranslationCatalogEnvelope {
  readonly direction: TextDirection;
  readonly locale: LocaleCode;
  readonly messages: unknown;
  readonly messagesPath: string;
  readonly name: string;
}

const catalogModules = import.meta.glob<unknown>("./locales/*.json", {
  eager: true,
  import: "default",
});

export const translationCatalogs = decodeTranslationCatalogs(catalogModules);

export function decodeTranslationCatalogs(
  modules: Readonly<Record<string, unknown>>,
): readonly TranslationCatalog[] {
  const entries = Object.entries(modules).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    throw new Error("At least one translation catalog is required.");
  }

  const envelopes = entries.map(([path, source]) => decodeCatalogEnvelope(path, source));
  const localeCodes = new Set<string>();
  for (const envelope of envelopes) {
    if (localeCodes.has(envelope.locale)) {
      throw new Error(`Translation locale ${JSON.stringify(envelope.locale)} is duplicated.`);
    }
    localeCodes.add(envelope.locale);
  }
  const defaultEnvelope = envelopes.find((envelope) => envelope.locale === DEFAULT_LOCALE);
  if (defaultEnvelope === undefined) {
    throw new Error(
      `The default ${JSON.stringify(DEFAULT_LOCALE)} translation catalog is missing.`,
    );
  }
  const referenceMessages = decodeMessageTree(
    defaultEnvelope.messages,
    defaultEnvelope.messages,
    defaultEnvelope.messagesPath,
  );
  const catalogs = envelopes.map((envelope) =>
    Object.freeze({
      direction: envelope.direction,
      locale: envelope.locale,
      messages:
        envelope === defaultEnvelope
          ? referenceMessages
          : decodeMessageTree(envelope.messages, referenceMessages, envelope.messagesPath),
      name: envelope.name,
    }),
  );
  return Object.freeze(catalogs.toSorted((left, right) => left.locale.localeCompare(right.locale)));
}

export function resolveCatalog(
  catalogs: readonly TranslationCatalog[],
  requestedLanguages: readonly string[],
): TranslationCatalog {
  const byLocale = new Map(
    catalogs.map((catalog) => [catalog.locale.toLocaleLowerCase("en-US"), catalog] as const),
  );

  for (const requestedLanguage of requestedLanguages) {
    const canonical = canonicalLocaleOrNull(requestedLanguage);
    if (canonical === null) continue;
    const exact = byLocale.get(canonical.toLocaleLowerCase("en-US"));
    if (exact !== undefined) return exact;
  }

  for (const requestedLanguage of requestedLanguages) {
    const canonical = canonicalLocaleOrNull(requestedLanguage);
    if (canonical === null) continue;
    const language = new Intl.Locale(canonical).language;
    const languageMatch = catalogs.find(
      (catalog) => new Intl.Locale(catalog.locale).language === language,
    );
    if (languageMatch !== undefined) return languageMatch;
  }

  const fallback = byLocale.get(DEFAULT_LOCALE);
  if (fallback === undefined) {
    throw new Error(
      `The default ${JSON.stringify(DEFAULT_LOCALE)} translation catalog is missing.`,
    );
  }
  return fallback;
}

export function findCatalog(
  catalogs: readonly TranslationCatalog[],
  locale: string,
): TranslationCatalog | null {
  const canonical = canonicalLocaleOrNull(locale);
  if (canonical === null) return null;
  return (
    catalogs.find(
      (catalog) =>
        catalog.locale.toLocaleLowerCase("en-US") === canonical.toLocaleLowerCase("en-US"),
    ) ?? null
  );
}

function decodeCatalogEnvelope(path: string, source: unknown): TranslationCatalogEnvelope {
  const fileName = /(?:^|[/\\])([^/\\]+)\.json$/u.exec(path)?.[1];
  if (fileName === undefined) {
    throw new Error(`Translation catalog path ${JSON.stringify(path)} must end in a JSON file.`);
  }
  const object = exactRecord(source, path, ["direction", "locale", "messages", "name"]);
  const locale = decodeLocale(object.locale, `${path}.locale`);
  if (fileName !== locale) {
    throw new Error(
      `${path}.locale must match its file name ${JSON.stringify(fileName)}; received ${JSON.stringify(locale)}.`,
    );
  }
  const direction = decodeDirection(object.direction, `${path}.direction`);
  const name = decodeBoundedText(object.name, `${path}.name`, MAXIMUM_CATALOG_NAME_CHARACTERS);
  return Object.freeze({
    direction,
    locale,
    messages: object.messages,
    messagesPath: `${path}.messages`,
    name,
  });
}

function decodeMessageTree(value: unknown, reference: unknown, path: string): TranslationMessages {
  return decodeMessageNode(value, reference, path) as TranslationMessages;
}

function decodeMessageNode(value: unknown, reference: unknown, path: string): unknown {
  if (typeof reference === "string") {
    const message = decodeBoundedText(value, path, MAXIMUM_MESSAGE_CHARACTERS);
    const expectedPlaceholders = translationPlaceholders(reference);
    const receivedPlaceholders = translationPlaceholders(message);
    if (
      expectedPlaceholders.length !== receivedPlaceholders.length ||
      expectedPlaceholders.some((key, index) => key !== receivedPlaceholders[index])
    ) {
      throw new Error(
        `${path} must contain placeholders ${expectedPlaceholders.join(", ") || "none"}; received ${receivedPlaceholders.join(", ") || "none"}.`,
      );
    }
    return message;
  }

  const referenceObject = plainRecord(reference, `${path} reference`);
  const object = exactRecord(value, path, Object.keys(referenceObject));
  return Object.freeze(
    Object.fromEntries(
      Object.keys(referenceObject).map((key) => [
        key,
        decodeMessageNode(object[key], referenceObject[key], `${path}.${key}`),
      ]),
    ),
  );
}

function decodeLocale(value: unknown, path: string): LocaleCode {
  const locale = decodeBoundedText(value, path, 35);
  const canonical = canonicalLocaleOrNull(locale);
  if (canonical === null || canonical !== locale) {
    throw new Error(`${path} must be a canonical Unicode locale identifier.`);
  }
  return locale as LocaleCode;
}

function canonicalLocaleOrNull(locale: string): string | null {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
  }
}

function decodeDirection(value: unknown, path: string): TextDirection {
  if (value === "ltr" || value === "rtl") return value;
  throw new Error(`${path} must be either "ltr" or "rtl".`);
}

function decodeBoundedText(value: unknown, path: string, maximumCharacters: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumCharacters) {
    throw new Error(`${path} must contain between 1 and ${maximumCharacters} characters.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new Error(`${path} must not contain control characters.`);
  }
  return value;
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  path: string,
  expectedKeys: Keys,
): Record<Keys[number], unknown> {
  const object = plainRecord(value, path);
  const actualKeys = Object.keys(object).toSorted();
  const sortedExpectedKeys = [...expectedKeys].toSorted();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(
      `${path} must contain exactly ${sortedExpectedKeys.join(", ")}; received ${actualKeys.join(", ")}.`,
    );
  }
  return object as Record<Keys[number], unknown>;
}

function plainRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object.`);
  }
  return value as UnknownRecord;
}
