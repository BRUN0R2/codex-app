import { Match, Switch } from "solid-js";

import type { TimelineEntry } from "../chat/timelineTypes";
import { ApprovalRequestPanel } from "./ApprovalRequestPanel";
import { McpRequestPanel } from "./McpRequestPanel";
import { PermissionsRequestPanel } from "./PermissionsRequestPanel";
import { UnsupportedRequestPanel } from "./UnsupportedRequestPanel";
import { UserInputRequestPanel } from "./UserInputRequestPanel";
import type {
  InteractiveServerRequest,
  PendingServerRequest,
  ServerResponseFor,
} from "./serverRequestTypes";

export interface InteractiveRequestPanelProps {
  onInterrupt: (request: PendingServerRequest) => Promise<void>;
  onRespond: <T extends InteractiveServerRequest>(
    request: T,
    response: ServerResponseFor<T>,
  ) => Promise<boolean>;
  pendingCount: number;
  request: PendingServerRequest;
  timeline: TimelineEntry[];
}

export function InteractiveRequestPanel(props: InteractiveRequestPanelProps) {
  return (
    <div class="interactive-request-wrap">
      <Switch>
        <Match
          when={
            props.request.kind === "commandApproval" ||
            props.request.kind === "fileChangeApproval"
              ? props.request
              : undefined
          }
        >
          {(request) => (
            <ApprovalRequestPanel
              onRespond={props.onRespond}
              pendingCount={props.pendingCount}
              request={request()}
              timeline={props.timeline}
            />
          )}
        </Match>
        <Match when={props.request.kind === "userInput" ? props.request : undefined}>
          {(request) => (
            <UserInputRequestPanel
              onInterrupt={props.onInterrupt}
              onRespond={props.onRespond}
              pendingCount={props.pendingCount}
              request={request()}
            />
          )}
        </Match>
        <Match
          when={props.request.kind === "permissionsApproval" ? props.request : undefined}
        >
          {(request) => (
            <PermissionsRequestPanel
              onRespond={props.onRespond}
              pendingCount={props.pendingCount}
              request={request()}
            />
          )}
        </Match>
        <Match
          when={
            props.request.kind === "mcpForm" ||
            props.request.kind === "mcpUrl" ||
            props.request.kind === "mcpUnsupportedForm"
              ? props.request
              : undefined
          }
        >
          {(request) => (
            <McpRequestPanel
              onRespond={props.onRespond}
              pendingCount={props.pendingCount}
              request={request()}
            />
          )}
        </Match>
        <Match when={props.request.kind === "unsupported" ? props.request : undefined}>
          {(request) => (
            <UnsupportedRequestPanel
              onInterrupt={props.onInterrupt}
              pendingCount={props.pendingCount}
              request={request()}
            />
          )}
        </Match>
      </Switch>
    </div>
  );
}
