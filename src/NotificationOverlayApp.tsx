import { createEffect, onCleanup, Show } from "solid-js";

import { createI18nController, I18nProvider, useI18n } from "./i18n/context";
import { formatMessage, type TranslationMessages } from "./i18n/messages";
import { createNotificationOverlayController } from "./state/notificationOverlayController";
import { CodexGlyph } from "./ui/CodexGlyph";
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
  const controller = createNotificationOverlayController();
  let card: HTMLElement | undefined;
  let progress: HTMLElement | undefined;
  let progressAnimation: Animation | null = null;
  let animatedNotificationId: string | null = null;

  createEffect(() => {
    const notificationId = controller.notification()?.id;
    if (notificationId === undefined) return;
    queueMicrotask(() => {
      if (controller.notification()?.id === notificationId && card !== undefined) {
        controller.synchronizePresentation(card);
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

  onCleanup(() => progressAnimation?.cancel());

  return (
    <Show when={controller.notification()}>
      {(notification) => {
        const priority = () => notification().presentation.type === "priority";
        const targetLabel = () =>
          notification().target?.type === "thread"
            ? i18n.messages().notifications.openTask
            : i18n.messages().notifications.openUsage;
        return (
          <main
            aria-label={notification().title}
            aria-live={priority() ? "assertive" : "polite"}
            class="notification-overlay-surface"
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
                  !(event.target instanceof Element && event.target.closest("button") !== null)
                ) {
                  controller.startDrag();
                }
              }}
              ref={card}
              role={priority() ? "alertdialog" : "status"}
            >
              <div class="notification-card-header">
                <span aria-hidden="true" class="notification-mark">
                  <CodexGlyph size={19} />
                </span>
                <span aria-hidden="true" class="notification-tone-icon">
                  <Icon name={toneIcon(notification().tone)} size={16} />
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

function toneIcon(tone: "attention" | "error" | "success"): IconName {
  if (tone === "success") return "check";
  if (tone === "error") return "close";
  return "helpCircle";
}

function eventLabel(
  event:
    | "approvalRequired"
    | "lunaReserveAvailable"
    | "taskCompleted"
    | "taskFailed"
    | "usageLimitReset"
    | "usageResetAvailable",
  messages: TranslationMessages["notifications"],
): string {
  return messages.events[event];
}
