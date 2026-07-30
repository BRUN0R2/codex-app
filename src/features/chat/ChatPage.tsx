import { Show } from "solid-js";

import { UsageLimitNotice } from "../account/UsageLimitNotice";
import { InteractiveRequestPanel } from "../approvals/InteractiveRequestPanel";
import { ConfigWarningNotice } from "../notices/ConfigWarningNotice";
import { WindowsWorldWritableWarning } from "../security/WindowsWorldWritableWarning";
import type { CodexSession } from "../session/createCodexSession";
import { Composer } from "./Composer";
import { Timeline } from "./Timeline";
import { TurnProgress } from "./TurnProgress";

interface ChatPageProps {
  session: CodexSession;
  onOpenSettings: () => void;
}

export function ChatPage(props: ChatPageProps) {
  const composerBlocked = () =>
    props.session.worldWritableWarningState().type !== "idle";

  return (
    <section class="chat-page">
      <Timeline busy={props.session.busy()} entries={props.session.timeline()} />
      <TurnProgress
        busy={props.session.busy()}
        progress={props.session.turnProgress()}
      />
      <Show when={props.session.pendingServerRequests()[0]}>
        {(request) => (
          <InteractiveRequestPanel
            onInterrupt={props.session.interruptPendingRequest}
            onRespond={props.session.respondToInteractiveRequest}
            pendingCount={props.session.pendingServerRequests().length}
            request={request()}
            timeline={props.session.timeline()}
          />
        )}
      </Show>
      <ConfigWarningNotice
        onOpenSettings={props.onOpenSettings}
        session={props.session}
      />
      <WindowsWorldWritableWarning session={props.session} />
      <UsageLimitNotice session={props.session} />
      <Composer
        busy={props.session.busy()}
        config={props.session.config()}
        disabled={composerBlocked()}
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
