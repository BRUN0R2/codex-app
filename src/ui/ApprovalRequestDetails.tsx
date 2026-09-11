import type { EngineServerRequest } from "../contracts/types";
import { useI18n } from "../i18n/context";

export function ApprovalRequestDetails(props: { readonly request: EngineServerRequest }) {
  const i18n = useI18n();
  const subject = () =>
    props.request.method === "approval.command"
      ? props.request.params.command
      : props.request.params.origin;
  const context = () =>
    props.request.method === "approval.command"
      ? props.request.params.cwd
      : i18n.messages().approval.browserDescription;

  return (
    <>
      <p class="approval-request-reason">{props.request.params.reason}</p>
      <pre class="approval-command">{subject()}</pre>
      <small class="approval-request-context">{context()}</small>
    </>
  );
}
