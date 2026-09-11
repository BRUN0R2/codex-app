import type { ConfigurableNotificationEventKind } from "../contracts/notificationOverlay";
import type { TranslationMessages } from "../i18n/messages";
import { formatMessage } from "../i18n/messages";
import type { AppNotificationInput } from "./appNotifications";

export function createNotificationPreview(
  event: ConfigurableNotificationEventKind,
  messages: TranslationMessages["notifications"],
  sequence: number,
): AppNotificationInput & { readonly event: ConfigurableNotificationEventKind } {
  const identity = `notification-preview:${event}:${sequence}`;
  const task = messages.untitledTask;
  switch (event) {
    case "approvalRequired":
      return {
        approval: null,
        id: identity,
        event,
        tone: "attention",
        title: messages.approvalTitle,
        message: formatMessage(messages.approvalMessage, { task }),
        target: null,
      };
    case "taskCompleted":
      return {
        approval: null,
        id: identity,
        event,
        tone: "success",
        title: messages.taskCompletedTitle,
        message: formatMessage(messages.taskCompletedMessage, { task }),
        target: null,
      };
    case "taskFailed":
      return {
        approval: null,
        id: identity,
        event,
        tone: "error",
        title: messages.taskFailedTitle,
        message: formatMessage(messages.taskFailedMessage, { task }),
        target: null,
      };
    case "usageLimitReset":
      return {
        approval: null,
        id: identity,
        event,
        tone: "success",
        title: messages.usageLimitResetTitle,
        message: formatMessage(messages.usageLimitResetMessage, { percent: 100 }),
        target: null,
      };
    case "usageResetAvailable":
      return {
        approval: null,
        id: identity,
        event,
        tone: "attention",
        title: messages.usageResetAvailableTitle,
        message: formatMessage(messages.usageResetAvailableMessage, { count: 1 }),
        target: null,
      };
    case "lunaReserveAvailable":
      return {
        approval: null,
        id: identity,
        event,
        tone: "attention",
        title: messages.lunaReserveAvailableTitle,
        message: messages.lunaReserveAvailableMessage,
        target: null,
      };
  }
}
