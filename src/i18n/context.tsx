import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  useContext,
} from "solid-js";

import { PROFILE_STORAGE_KEYS } from "../state/profileStorage";
import {
  findCatalog,
  type LocaleCode,
  resolveCatalog,
  type TranslationCatalog,
  translationCatalogs,
} from "./catalog";
import type { TranslationMessages } from "./messages";

export type LocalePreference = "auto" | LocaleCode;
export type LocaleStorageIssue = "readFailure" | "unsupportedPreference" | "writeFailure";

interface LocaleStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface I18nController {
  readonly availableCatalogs: readonly TranslationCatalog[];
  readonly locale: Accessor<LocaleCode>;
  readonly messages: Accessor<TranslationMessages>;
  readonly preference: Accessor<LocalePreference>;
  readonly setPreference: (preference: LocalePreference) => void;
  readonly storageIssue: Accessor<LocaleStorageIssue | null>;
}

interface I18nControllerOptions {
  readonly languages?: readonly string[] | undefined;
  readonly storage?: LocaleStorage | null | undefined;
}

const I18nContext = createContext<I18nController>();

export function createI18nController(options: I18nControllerOptions = {}): I18nController {
  const storage = options.storage === undefined ? defaultLocaleStorage() : options.storage;
  const languages = options.languages ?? defaultLanguages();
  const stored = readPreference(storage);
  const [preference, setPreferenceSignal] = createSignal<LocalePreference>(stored.preference);
  const [storageIssue, setStorageIssue] = createSignal<LocaleStorageIssue | null>(stored.issue);
  const catalog = createMemo(() => {
    const selected = preference();
    if (selected === "auto") return resolveCatalog(translationCatalogs, languages);
    const exact = findCatalog(translationCatalogs, selected);
    if (exact === null) {
      throw new Error(`Selected translation locale ${JSON.stringify(selected)} is unavailable.`);
    }
    return exact;
  });

  createEffect(() => {
    const selected = catalog();
    if (typeof document === "undefined") return;
    document.documentElement.lang = selected.locale;
    document.documentElement.dir = selected.direction;
  });

  function setPreference(nextPreference: LocalePreference): void {
    if (nextPreference !== "auto" && findCatalog(translationCatalogs, nextPreference) === null) {
      throw new Error(
        `Translation locale ${JSON.stringify(nextPreference)} cannot be selected because it is unavailable.`,
      );
    }
    setPreferenceSignal(nextPreference);
    setStorageIssue(null);
    if (storage === null) return;
    try {
      storage.setItem(PROFILE_STORAGE_KEYS.locale, nextPreference);
    } catch {
      setStorageIssue("writeFailure");
    }
  }

  return {
    availableCatalogs: translationCatalogs,
    locale: () => catalog().locale,
    messages: () => catalog().messages,
    preference,
    setPreference,
    storageIssue,
  };
}

export function I18nProvider(props: {
  readonly children: JSX.Element;
  readonly controller: I18nController;
}) {
  return <I18nContext.Provider value={props.controller}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nController {
  const controller = useContext(I18nContext);
  if (controller === undefined) {
    throw new Error("The internationalization context is unavailable.");
  }
  return controller;
}

export function resolveInitialCatalog(
  languages: readonly string[] = defaultLanguages(),
  storage: LocaleStorage | null = defaultLocaleStorage(),
): TranslationCatalog {
  const stored = readPreference(storage).preference;
  return stored === "auto"
    ? resolveCatalog(translationCatalogs, languages)
    : (findCatalog(translationCatalogs, stored) ?? resolveCatalog(translationCatalogs, languages));
}

function readPreference(storage: LocaleStorage | null): {
  readonly issue: LocaleStorageIssue | null;
  readonly preference: LocalePreference;
} {
  if (storage === null) return { issue: null, preference: "auto" };
  let stored: string | null;
  try {
    stored = storage.getItem(PROFILE_STORAGE_KEYS.locale);
  } catch {
    return { issue: "readFailure", preference: "auto" };
  }
  if (stored === null || stored === "auto") return { issue: null, preference: "auto" };
  const catalog = findCatalog(translationCatalogs, stored);
  return catalog === null
    ? { issue: "unsupportedPreference", preference: "auto" }
    : { issue: null, preference: catalog.locale };
}

function defaultLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

function defaultLocaleStorage(): LocaleStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
