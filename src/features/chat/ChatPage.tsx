import type { CodexSession } from "../session/createCodexSession";
import { Composer } from "./Composer";
import { Timeline } from "./Timeline";

interface ChatPageProps {
  session: CodexSession;
  onOpenSettings: () => void;
}

export function ChatPage(props: ChatPageProps) {
  return (
    <section class="chat-page">
      <Timeline busy={props.session.busy()} entries={props.session.timeline()} />
      <Composer
        busy={props.session.busy()}
        config={props.session.config()}
        inspectFiles={props.session.inspectFiles}
        loadCompatibilityContext={props.session.loadCompatibilityContext}
        models={props.session.models()}
        onChooseWorkspace={props.session.chooseWorkspace}
        onInterrupt={props.session.interrupt}
        onOpenSettings={props.onOpenSettings}
        onSend={props.session.sendMessage}
        saveClipboardImage={props.session.saveClipboardImage}
        workspace={props.session.workspace()}
        writeSetting={props.session.writeSetting}
        writeSettings={props.session.writeSettings}
      />
    </section>
  );
}
