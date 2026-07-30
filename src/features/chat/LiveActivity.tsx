import {
  ClockIcon,
  EditIcon,
  GlobeIcon,
  ImageIcon,
  ImagesIcon,
  SparkIcon,
  TerminalIcon,
  UsersIcon,
} from "../../shared/components/Icons";
import { agentToolLabel } from "./AgentActivity";
import { ToolBadge } from "./ToolActivity";
import type { GroupableTimelineEntry } from "./timelineTypes";

export function LiveActivity(props: { entry: GroupableTimelineEntry }) {
  const label = () => liveActivityLabel(props.entry);
  return (
    <div class="live-activity" title={label()}>
      <LiveActivityIcon entry={props.entry} />
      <span class="live-activity-label">{label()}</span>
    </div>
  );
}

function LiveActivityIcon(props: { entry: GroupableTimelineEntry }) {
  switch (props.entry.type) {
    case "fileChange":
      return <EditIcon size={13} />;
    case "imageView":
      return <ImagesIcon size={13} />;
    case "imageGeneration":
      return <ImageIcon size={13} />;
    case "tool":
      return <ToolBadge />;
    case "agentTool":
    case "subAgentActivity":
      return <UsersIcon size={13} />;
    case "webSearch":
      return <GlobeIcon size={13} />;
    case "sleep":
      return <ClockIcon size={13} />;
    case "hookPrompt":
      return <SparkIcon size={13} />;
    case "activity":
    case "command":
      return <TerminalIcon size={13} />;
  }
}

function liveActivityLabel(entry: GroupableTimelineEntry): string {
  switch (entry.type) {
    case "command":
      return `Executando ${entry.command}`;
    case "fileChange":
      return "Editando arquivos";
    case "imageView":
      return "Visualizando imagem";
    case "imageGeneration":
      return "Gerando imagem";
    case "tool":
      return entry.progress.at(-1) ?? `Usando ${entry.name}`;
    case "agentTool":
      return agentToolLabel(entry);
    case "subAgentActivity":
      return "Acompanhando subagente";
    case "webSearch":
      return `Pesquisando ${entry.query}`;
    case "sleep":
      return "Aguardando";
    case "hookPrompt":
      return "Executando hook";
    case "activity":
      return entry.label;
  }
}
