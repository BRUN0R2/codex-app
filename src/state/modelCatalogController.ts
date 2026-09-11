import { type Accessor, batch, createSignal } from "solid-js";

import type { ChatModelOption, CodexModel, ConversationMode } from "../contracts/types";
import { listChatModels, listModels } from "../infrastructure/codexClient";
import type { SessionControllerHost } from "./controllerSupport";

export interface ModelCatalogController {
  readonly chatModels: Accessor<readonly ChatModelOption[]>;
  readonly models: Accessor<readonly CodexModel[]>;
  readonly ensureModelsForMode: (mode: ConversationMode) => Promise<boolean>;
  readonly invalidateCatalogs: () => void;
}

export interface ModelCatalogDependencies {
  readonly host: SessionControllerHost;
  readonly isSignedIn: () => boolean;
}

export function createModelCatalogController(
  dependencies: ModelCatalogDependencies,
): ModelCatalogController {
  const { host, isSignedIn } = dependencies;
  const [chatModels, setChatModels] = createSignal<readonly ChatModelOption[]>([]);
  const [models, setModels] = createSignal<readonly CodexModel[]>([]);
  let modelCatalogSessionRevision = 0;

  function ensureModelsForMode(mode: ConversationMode): Promise<boolean> {
    return mode === "chat" ? loadChatModelCatalog() : loadModelCatalog();
  }

  function loadModelCatalog(): Promise<boolean> {
    const revision = modelCatalogSessionRevision;
    return host.singleFlight.run(`models:codex:${revision}`, async () => {
      try {
        const catalog = await listModels();
        if (host.isDisposed() || revision !== modelCatalogSessionRevision || !isSignedIn()) {
          return false;
        }
        setModels(catalog.data.filter((model) => !model.hidden));
        return true;
      } catch (reason) {
        if (!host.isDisposed() && revision === modelCatalogSessionRevision) {
          host.reportError(reason);
        }
        return false;
      }
    });
  }

  function loadChatModelCatalog(): Promise<boolean> {
    const revision = modelCatalogSessionRevision;
    return host.singleFlight.run(`models:chat:${revision}`, async () => {
      try {
        const catalog = await listChatModels();
        if (host.isDisposed() || revision !== modelCatalogSessionRevision || !isSignedIn()) {
          return false;
        }
        setChatModels(catalog.data);
        return true;
      } catch (reason) {
        if (!host.isDisposed() && revision === modelCatalogSessionRevision) {
          host.reportError(reason);
        }
        return false;
      }
    });
  }

  function invalidateCatalogs(): void {
    modelCatalogSessionRevision += 1;
    batch(() => {
      setModels([]);
      setChatModels([]);
    });
  }

  return {
    chatModels,
    models,
    ensureModelsForMode,
    invalidateCatalogs,
  };
}
