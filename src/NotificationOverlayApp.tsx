import { createEffect, onCleanup, Show } from "solid-js";

import {
  type AppNotification,
  decodeNotificationChannel,
  type NotificationEventKind,
} from "./contracts/notificationOverlay";
import { createI18nController, I18nProvider, useI18n } from "./i18n/context";
import { formatMessage, type TranslationMessages } from "./i18n/messages";
import { createNotificationOverlayPreviewController } from "./preview/notificationOverlayPreviewController";
import { createNotificationOverlayController } from "./state/notificationOverlayController";
import { ApprovalDecisionButtons } from "./ui/ApprovalDecisionButtons";
import { ApprovalRequestDetails } from "./ui/ApprovalRequestDetails";
import { observeElementResize, readResizeObserverBorderBoxHeight } from "./ui/elementResize";
import { Icon, type IconName } from "./ui/Icon";
import "./styles/notification-overlay.css";

export default function NotificationOverlayApp() {
  const i18n = createI18nController();
  return (
    <I18nProvider controller={i18n}>
      <NotificationOverlay />
    </I18nProvider>
  );
}

function NotificationOverlay() {
  const i18n = useI18n();
  const parameters = new URLSearchParams(window.location.search);
  const channel = decodeNotificationChannel(parameters.get("channel"), "$url.channel");
  const controller =
    parameters.get("preview") === "1"
      ? createNotificationOverlayPreviewController(channel)
      : createNotificationOverlayController(channel);
  let surface: HTMLElement | undefined;
  let progress: HTMLElement | undefined;
  let progressAnimation: Animation | null = null;
  let animatedNotificationId: string | null = null;
  let releaseSurfaceObservation: (() => void) | null = null;

  function bindSurface(element: HTMLElement): void {
    releaseSurfaceObservation?.();
    surface = element;
    releaseSurfaceObservation = observeElementResize(element, (entry) => {
      const height =
        readResizeObserverBorderBoxHeight(entry) ?? element.getBoundingClientRect().height;
      controller.synchronizePresentation(height);
    });
  }

  createEffect(() => {
    const notificationId = controller.notification()?.id;
    if (notificationId === undefined) return;
    queueMicrotask(() => {
      if (controller.notification()?.id === notificationId && surface !== undefined) {
        controller.synchronizePresentation(surface.getBoundingClientRect().height);
      }
    });
  });

  createEffect(() => {
    const notification = controller.notification();
    if (notification?.presentation.type !== "transient") {
      animatedNotificationId = null;
      progressAnimation?.cancel();
      progressAnimation = null;
      return;
    }
    if (notification.id === animatedNotificationId) return;
    animatedNotificationId = notification.id;
    const notificationId = notification.id;
    const durationMilliseconds = notification.presentation.durationSeconds * 1_000;
    progressAnimation?.cancel();
    progressAnimation = null;
    queueMicrotask(() => {
      if (
        controller.notification()?.id !== notificationId ||
        progress === undefined ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return;
      }
      progressAnimation = progress.animate(
        [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
        { duration: durationMilliseconds, easing: "linear", fill: "forwards" },
      );
    });
  });

  onCleanup(() => {
    releaseSurfaceObservation?.();
    progressAnimation?.cancel();
  });

  return (
    <Show when={controller.notification()}>
      {(notification) => {
        const priority = () => notification().presentation.type === "priority";
        const targetLabel = () =>
          notification().target?.type === "thread"
            ? i18n.messages().notifications.openTask
            : i18n.messages().notifications.openUsage;
        const hasStandardFooter = () =>
          notification().approval === null &&
          (notification().target !== null || controller.pendingCount() > 1);
        return (
          <main
            aria-label={notification().title}
            aria-live={priority() ? "assertive" : "polite"}
            class="notification-overlay-surface"
            ref={bindSurface}
          >
            <section
              aria-describedby="notification-message"
              aria-labelledby="notification-title"
              class="notification-card"
              classList={{
                priority: priority(),
                transient: !priority(),
                [`tone-${notification().tone}`]: true,
              }}
              onPointerDown={(event) => {
                if (
                  priority() &&
                  event.button === 0 &&
                  !(
                    event.target instanceof Element &&
                    event.target.closest("button, [data-notification-interactive]") !== null
                  )
                ) {
                  controller.startDrag();
                }
              }}
              role={priority() ? "alertdialog" : "status"}
            >
              <div class="notification-card-header">
                <span aria-hidden="true" class="notification-icon">
                  <Icon name={notificationIcon(notification())} size={16} />
                </span>
                <div>
                  <p>{eventLabel(notification().event, i18n.messages().notifications)}</p>
                  <h1 id="notification-title">{notification().title}</h1>
                </div>
                <button
                  aria-label={i18n.messages().notifications.dismiss}
                  class="notification-close"
                  onClick={() => controller.dismiss(notification().id)}
                  type="button"
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
              <p class="notification-message" id="notification-message">
                {notification().message}
              </p>
              <Show when={notification().approval}>
                {(request) => (
                  <div class="notification-approval" data-notification-interactive>
                    <ApprovalRequestDetails request={request()} />
                    <Show when={controller.approvalResponseFailed()}>
                      <p class="notification-approval-error" role="alert">
                        {i18n.messages().notifications.approvalResponseFailed}
                      </p>
                    </Show>
                    <div
                      aria-busy={controller.approvalResponding()}
                      class="notification-approval-actions"
                    >
                      <Show when={controller.pendingCount() > 1}>
                        <span class="notification-pending-count">
                          {formatMessage(i18n.messages().notifications.pendingCount, {
                            count: controller.pendingCount() - 1,
                          })}
                        </span>
                      </Show>
                      <ApprovalDecisionButtons
                        buttonClass="notification-decision"
                        disabled={controller.approvalResponding()}
                        onDecision={(decision) =>
                          controller.respondToApproval(notification().id, request().id, decision)
                        }
                        request={request()}
                      />
                    </div>
                  </div>
                )}
              </Show>
              <Show when={hasStandardFooter()}>
                <div class="notification-card-footer">
                  <Show when={notification().target !== null}>
                    <button
                      class="notification-action"
                      onClick={() => controller.activate(notification().id)}
                      type="button"
                    >
                      {targetLabel()}
                    </button>
                  </Show>
                  <Show when={controller.pendingCount() > 1}>
                    <span>
                      {formatMessage(i18n.messages().notifications.pendingCount, {
                        count: controller.pendingCount() - 1,
                      })}
                    </span>
                  </Show>
                </div>
              </Show>
              <Show when={!priority()}>
                <i aria-hidden="true" class="notification-progress" ref={progress} />
              </Show>
            </section>
          </main>
        );
      }}
    </Show>
  );
}

function notificationIcon(notification: AppNotification): IconName {
  if (notification.approval?.method === "approval.command") return "shield";
  if (notification.approval?.method === "approval.browserOrigin") return "globe";
  if (notification.tone === "success") return "check";
  if (notification.tone === "error") return "close";
  return "helpCircle";
}

function eventLabel(
  event: NotificationEventKind,
  messages: TranslationMessages["notifications"],
): string {
  return messages.events[event];
}
