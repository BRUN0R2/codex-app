import { For, Show } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  UsersIcon,
} from "../../shared/components/Icons";
import { humanizeIdentifier } from "./timelineParsing";
import type {
  AgentToolEntry,
  SubAgentActivityEntry,
} from "./timelineTypes";

interface AgentToolActivityProps {
  entry: AgentToolEntry;
  expanded: boolean;
  onToggle: () => void;
}

export function AgentToolActivity(props: AgentToolActivityProps) {
  const hasDetail = () =>
    props.entry.prompt !== null ||
    props.entry.model !== null ||
    props.entry.reasoningEffort !== null ||
    props.entry.receiverThreadIds.length > 0 ||
    props.entry.agents.length > 0;

  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={hasDetail() ? props.expanded : undefined}
        class="activity-item-button"
        disabled={!hasDetail()}
        onClick={props.onToggle}
        type="button"
      >
        <UsersIcon size={13} />
        <span class="activity-item-label">{agentToolLabel(props.entry)}</span>
        <Show when={props.entry.receiverThreadIds.length > 0}>
          <span class="activity-item-detail">
            {props.entry.receiverThreadIds.length === 1
              ? "1 agente"
              : `${props.entry.receiverThreadIds.length} agentes`}
          </span>
        </Show>
        <Show when={hasDetail()}>
          <span class="activity-row-chevron">
            {props.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </span>
        </Show>
      </button>
      <Show when={props.expanded && hasDetail()}>
        <div class="command-card agent-card">
          <div class="detail-card-title">Agente</div>
          <dl class="activity-facts">
            <Show when={props.entry.model !== null}>
              <div>
                <dt>Modelo</dt>
                <dd>{props.entry.model}</dd>
              </div>
            </Show>
            <Show when={props.entry.reasoningEffort !== null}>
              <div>
                <dt>Esforço</dt>
                <dd>{humanizeIdentifier(props.entry.reasoningEffort ?? "")}</dd>
              </div>
            </Show>
            <Show when={props.entry.prompt !== null}>
              <div class="activity-fact-wide">
                <dt>Instrução</dt>
                <dd>{props.entry.prompt}</dd>
              </div>
            </Show>
            <For each={props.entry.agents}>
              {(agent, index) => (
                <div>
                  <dt>Agente {index() + 1}</dt>
                  <dd>
                    {humanizeIdentifier(agent.status)}
                    <Show when={agent.message !== null}>
                      {` · ${agent.message}`}
                    </Show>
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </div>
      </Show>
    </div>
  );
}

export function SubAgentActivity(props: { entry: SubAgentActivityEntry }) {
  return (
    <div class="activity-item-static">
      <UsersIcon size={13} />
      <span class="activity-item-label">{subAgentLabel(props.entry)}</span>
      <Show when={props.entry.agentPath.length > 0}>
        <span class="activity-item-detail">{props.entry.agentPath}</span>
      </Show>
    </div>
  );
}

export function agentToolLabel(entry: AgentToolEntry): string {
  const failed = entry.status === "failed";
  switch (entry.action) {
    case "spawnAgent":
      return failed ? "Falhou ao criar agente" : "Criou agente";
    case "sendInput":
      return failed ? "Falhou ao orientar agente" : "Orientou agente";
    case "resumeAgent":
      return failed ? "Falhou ao retomar agente" : "Retomou agente";
    case "wait":
      return failed ? "Falhou ao aguardar agentes" : "Aguardou agentes";
    case "closeAgent":
      return failed ? "Falhou ao encerrar agente" : "Encerrou agente";
  }
}

function subAgentLabel(entry: SubAgentActivityEntry): string {
  switch (entry.kind) {
    case "started":
      return "Subagente iniciou uma atividade";
    case "interacted":
      return "Subagente atualizou a atividade";
    case "interrupted":
      return "Subagente foi interrompido";
  }
}
