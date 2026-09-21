import { type Accessor, batch, createSignal } from "solid-js";

import type { ApplicationPreferences } from "../contracts/types";
import {
  readApplicationPreferences,
  updateApplicationPreferences as updateApplicationPreferencesCommand,
} from "../infrastructure/codexClient";
import { isBrowserPreview, isDesktopRuntime } from "../platform/desktopRuntime";
import {
  type ApplicationPreferencesPatch,
  DEFAULT_APPLICATION_PREFERENCES,
  mergeApplicationPreferences,
} from "./applicationPreferences";
import { settledQueueTail, withBootTimeout } from "./controllerSupport";
import { type UiError, uiError } from "./uiError";

const APPLICATION_PREFERENCES_READ_TIMEOUT_MS = 15_000;

export interface ApplicationPreferencesController {
  readonly applicationPreferences: Accessor<ApplicationPreferences>;
  readonly applicationPreferencesError: Accessor<UiError | null>;
  readonly applicationPreferencesLoaded: Accessor<boolean>;
  readonly applicationPreferencesSaving: Accessor<boolean>;
  readonly loadApplicationPreferences: () => Promise<void>;
  readonly updateApplicationPreferences: (patch: ApplicationPreferencesPatch) => Promise<boolean>;
}

export interface ApplicationPreferencesDependencies {
  readonly isDisposed: () => boolean;
  readonly onSaved: () => void;
  readonly reportError: (reason: unknown) => void;
}

export function createApplicationPreferencesController(
  dependencies: ApplicationPreferencesDependencies,
): ApplicationPreferencesController {
  const { isDisposed, onSaved, reportError } = dependencies;
  const [applicationPreferences, setApplicationPreferences] = createSignal<ApplicationPreferences>(
    DEFAULT_APPLICATION_PREFERENCES,
  );
  const [applicationPreferencesError, setApplicationPreferencesError] =
    createSignal<UiError | null>(null);
  const [applicationPreferencesLoaded, setApplicationPreferencesLoaded] = createSignal(false);
  const [applicationPreferencesSaving, setApplicationPreferencesSaving] = createSignal(false);
  let applicationPreferencesQueue: Promise<void> = Promise.resolve();
  let confirmedApplicationPreferences: ApplicationPreferences = DEFAULT_APPLICATION_PREFERENCES;
  let applicationPreferencesRevision = 0;

  async function loadApplicationPreferences(): Promise<void> {
    if (!isDesktopRuntime() && !isBrowserPreview()) {
      return;
    }
    setApplicationPreferencesError(null);
    try {
      const stored = await withBootTimeout(
        "load application preferences",
        APPLICATION_PREFERENCES_READ_TIMEOUT_MS,
        readApplicationPreferences,
      );
      confirmedApplicationPreferences = stored;
      setApplicationPreferences(stored);
      setApplicationPreferencesLoaded(true);
    } catch (reason) {
      setApplicationPreferencesError(uiError("applicationPreferencesLoad"));
      reportError(reason);
    }
  }

  async function updateApplicationPreferences(
    patch: ApplicationPreferencesPatch,
  ): Promise<boolean> {
    if (!applicationPreferencesLoaded()) return false;
    const desired = mergeApplicationPreferences(applicationPreferences(), patch);
    applicationPreferencesRevision += 1;
    const revision = applicationPreferencesRevision;
    batch(() => {
      setApplicationPreferences(desired);
      setApplicationPreferencesError(null);
      setApplicationPreferencesSaving(true);
    });

    const operation = applicationPreferencesQueue.then(async () => {
      const persisted = mergeApplicationPreferences(confirmedApplicationPreferences, patch);
      const stored = await updateApplicationPreferencesCommand(persisted);
      confirmedApplicationPreferences = stored;
      if (!isDisposed() && revision === applicationPreferencesRevision) {
        setApplicationPreferences(stored);
      }
    });
    applicationPreferencesQueue = settledQueueTail(operation);
    try {
      await operation;
      onSaved();
      return true;
    } catch (reason) {
      if (!isDisposed() && revision === applicationPreferencesRevision) {
        batch(() => {
          setApplicationPreferences(confirmedApplicationPreferences);
          setApplicationPreferencesError(uiError("applicationPreferencesSave"));
        });
      }
      reportError(reason);
      return false;
    } finally {
      if (!isDisposed() && revision === applicationPreferencesRevision) {
        setApplicationPreferencesSaving(false);
      }
    }
  }

  return {
    applicationPreferences,
    applicationPreferencesError,
    applicationPreferencesLoaded,
    applicationPreferencesSaving,
    loadApplicationPreferences,
    updateApplicationPreferences,
  };
}
