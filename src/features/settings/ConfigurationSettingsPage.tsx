import { createMemo } from "solid-js";

import { configString } from "../../shared/codex/models";
import type {
  ApprovalPolicy,
  GranularApprovalPolicy,
  SandboxMode,
} from "../../shared/codex/types";
import { isJsonObject } from "../../shared/codex/types";
import { RefreshIcon } from "../../shared/components/Icons";
import { SettingsPageHeading, SettingsSection, SettingsSelect } from "./SettingsControls";
import { isAdministrativelyManaged } from "./configPolicy";
import type { SelectOption, SettingsPageProps } from "./settingsTypes";

const APPROVAL_OPTIONS: ReadonlyArray<SelectOption & { value: ApprovalPolicy }> = [
  { label: "Apenas ações desconhecidas", value: "untrusted" },
  { label: "Quando necessário", value: "on-request" },
  { label: "Nunca", value: "never" },
];

const SANDBOX_OPTIONS: ReadonlyArray<SelectOption & { value: SandboxMode }> = [
  { label: "Somente leitura", value: "read-only" },
  { label: "Permissões padrão", value: "workspace-write" },
  { label: "Acesso completo", value: "danger-full-access" },
];

export function ConfigurationSettingsPage(props: SettingsPageProps) {
  const allowedApprovalPolicies = createMemo(
    () =>
      props.session.configRequirements()?.requirements?.allowedApprovalPolicies
      ?? null,
  );
  const allowedSandboxModes = createMemo(
    () => props.session.configRequirements()?.requirements?.allowedSandboxModes ?? null,
  );
  const approvalOptions = createMemo<SelectOption[]>(() => {
    const allowed = allowedApprovalPolicies();
    const options = allowed === null
      ? [...APPROVAL_OPTIONS]
      : APPROVAL_OPTIONS.filter((option) => allowed.includes(option.value));
    return approvalValue(props.session.config()?.config.approval_policy) === "granular"
      ? [{ label: "Política granular", value: "granular" }, ...options]
      : options;
  });
  const sandboxOptions = createMemo(() => {
    const allowed = allowedSandboxModes();
    return allowed === null
      ? [...SANDBOX_OPTIONS]
      : SANDBOX_OPTIONS.filter((option) => allowed.includes(option.value));
  });
  const saving = () => props.savingKey() !== null;
  const approvalManaged = () =>
    allowedApprovalPolicies() !== null
    || isAdministrativelyManaged(props.session.config(), "approval_policy");
  const approvalLocked = () =>
    isAdministrativelyManaged(props.session.config(), "approval_policy")
    || (allowedApprovalPolicies() !== null && approvalOptions().length <= 1);
  const sandboxManaged = () =>
    allowedSandboxModes() !== null
    || isAdministrativelyManaged(props.session.config(), "sandbox_mode");
  const sandboxLocked = () =>
    isAdministrativelyManaged(props.session.config(), "sandbox_mode")
    || (allowedSandboxModes() !== null && sandboxOptions().length <= 1);
  const reasoningSummaryManaged = () =>
    isAdministrativelyManaged(props.session.config(), "model_reasoning_summary");
  const verbosityManaged = () =>
    isAdministrativelyManaged(props.session.config(), "model_verbosity");

  return (
    <>
      <SettingsPageHeading
        description="Políticas de aprovação, sandbox e comportamento de resposta do Codex."
        title="Configuração"
      >
        <button
          aria-label="Atualizar configuração"
          class="icon-button settings-heading-action"
          disabled={saving()}
          onClick={() => void props.refreshConfig()}
          title="Atualizar configuração"
          type="button"
        >
          <RefreshIcon size={16} />
        </button>
      </SettingsPageHeading>

      <SettingsSection title="Permissões">
        <SettingsSelect
          description="Define quando o Codex precisa solicitar sua confirmação."
          disabled={saving() || approvalLocked()}
          label="Política de aprovação"
          managed={approvalManaged()}
          onChange={(next) => {
            if (next !== "granular") {
              void props.saveSetting("approval_policy", next);
            }
          }}
          options={approvalOptions()}
          value={approvalValue(props.session.config()?.config.approval_policy)}
        />
        <SettingsSelect
          description="Limita arquivos, rede e processos acessíveis durante a execução."
          disabled={saving() || sandboxLocked()}
          label="Configurações do sandbox"
          managed={sandboxManaged()}
          onChange={(next) => void props.saveSetting("sandbox_mode", next)}
          options={sandboxOptions()}
          value={configString(props.session.config(), "sandbox_mode") ?? "workspace-write"}
        />
      </SettingsSection>

      <SettingsSection title="Respostas do modelo">
        <SettingsSelect
          description="Formato padrão do resumo de raciocínio quando o modelo oferece suporte."
          disabled={saving() || reasoningSummaryManaged()}
          label="Resumo do raciocínio"
          managed={reasoningSummaryManaged()}
          onChange={(next) =>
            void props.saveSetting(
              "model_reasoning_summary",
              next.length === 0 ? null : next,
            )
          }
          options={[
            { label: "Padrão do modelo", value: "" },
            { label: "Automático", value: "auto" },
            { label: "Conciso", value: "concise" },
            { label: "Detalhado", value: "detailed" },
            { label: "Desativado", value: "none" },
          ]}
          value={configString(props.session.config(), "model_reasoning_summary") ?? ""}
        />
        <SettingsSelect
          description="Quantidade de detalhes da resposta final em modelos GPT-5."
          disabled={saving() || verbosityManaged()}
          label="Verbosidade"
          managed={verbosityManaged()}
          onChange={(next) =>
            void props.saveSetting("model_verbosity", next.length === 0 ? null : next)
          }
          options={[
            { label: "Padrão do modelo", value: "" },
            { label: "Baixa", value: "low" },
            { label: "Média", value: "medium" },
            { label: "Alta", value: "high" },
          ]}
          value={configString(props.session.config(), "model_verbosity") ?? ""}
        />
      </SettingsSection>

      <p class="settings-note">
        Restrições administrativas vêm de <code>requirements.toml</code> ou MDM e
        não são contornadas pela interface.
      </p>
    </>
  );
}

function approvalValue(value: unknown): ApprovalPolicy | "granular" {
  if (value === "never" || value === "on-request" || value === "untrusted") {
    return value;
  }
  return isGranularApproval(value) ? "granular" : "on-request";
}

function isGranularApproval(value: unknown): value is GranularApprovalPolicy {
  if (!isJsonObject(value) || !isJsonObject(value.granular)) {
    return false;
  }
  const granular = value.granular;
  return (
    typeof granular.mcp_elicitations === "boolean"
    && typeof granular.request_permissions === "boolean"
    && typeof granular.rules === "boolean"
    && typeof granular.sandbox_approval === "boolean"
    && typeof granular.skill_approval === "boolean"
  );
}
