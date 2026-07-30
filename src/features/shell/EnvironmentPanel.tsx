import { Show, createMemo } from "solid-js";

import {
  configuredModel,
  configuredReasoningEffort,
  reasoningLabel,
} from "../../shared/codex/models";
import {
  BranchIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  LaptopIcon,
  SettingsIcon,
  SparkIcon,
} from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";

interface EnvironmentPanelProps {
  onClose: () => void;
  onOpenSettings: () => void;
  session: CodexSession;
}

export function EnvironmentPanel(props: EnvironmentPanelProps) {
  const workspaceName = createMemo(() => {
    const path = props.session.workspace();
    return path?.split(/[\\/]/).at(-1) ?? "Selecionar projeto";
  });
  const model = createMemo(() =>
    configuredModel(props.session.config(), props.session.models()),
  );
  const effort = createMemo(() =>
    configuredReasoningEffort(props.session.config(), model()),
  );
  const modelsStatus = createMemo(() => {
    switch (props.session.compatibilityContextState()) {
      case "loading":
        return "Carregando modelos…";
      case "failed":
        return "Falha ao carregar modelos";
      case "idle":
        return "Modelos ainda não carregados";
      case "ready": {
        const count = props.session.models().length;
        return count === 1 ? "1 modelo disponível" : `${count} modelos disponíveis`;
      }
    }
  });

  return (
    <aside aria-label="Ambiente" class="environment-panel">
      <header class="environment-header">
        <span>Ambiente</span>
        <button
          aria-label="Ocultar painel de ambiente"
          class="icon-button compact-icon"
          onClick={props.onClose}
          type="button"
        >
          <CloseIcon size={15} />
        </button>
      </header>

      <section class="environment-section">
        <p>EXECUÇÃO</p>
        <button
          class="environment-row"
          onClick={() => void props.session.chooseWorkspace()}
          title={props.session.workspace() ?? "Selecionar pasta"}
          type="button"
        >
          <LaptopIcon size={17} />
          <span>
            <strong>Local</strong>
            <small>{workspaceName()}</small>
          </span>
          <ChevronRightIcon size={14} />
        </button>
        <div class="environment-row environment-row-static">
          <BranchIcon size={17} />
          <span>
            <strong>Sessão</strong>
            <small>{props.session.threadId() === null ? "Nova tarefa" : "Tarefa ativa"}</small>
          </span>
          <span class={`environment-status status-${props.session.runtimeStatus().state}`} />
        </div>
      </section>

      <section class="environment-section">
        <p>AGENTE</p>
        <div class="environment-row environment-row-static">
          <SparkIcon size={17} />
          <span>
            <strong>{model()?.displayName ?? "Modelo padrão"}</strong>
            <small>{reasoningLabel(effort())}</small>
          </span>
        </div>
        <button
          class="environment-row"
          onClick={props.onOpenSettings}
          type="button"
        >
          <SettingsIcon size={17} />
          <span>
            <strong>Configurações</strong>
            <small>{modelsStatus()}</small>
          </span>
          <ChevronRightIcon size={14} />
        </button>
      </section>

      <section class="environment-section environment-sources">
        <p>FONTES</p>
        <Show
          when={props.session.workspace()}
          fallback={<span class="environment-empty">Nenhum projeto selecionado</span>}
        >
          <div class="source-row" title={props.session.workspace() ?? undefined}>
            <FolderIcon size={16} />
            <span>{workspaceName()}</span>
          </div>
        </Show>
        <div class="source-row">
          <span class="codex-source-mark">C</span>
          <span>{props.session.runtime()?.engine.name ?? "Native Engine"}</span>
        </div>
      </section>
    </aside>
  );
}
