import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import { useI18n } from "../i18n/context";

import { Icon, type IconName } from "./Icon";
import { NotificationSettings } from "./NotificationSettings";
import { SurfaceScrollbar } from "./SurfaceScrollbar";
import type { SettingsDialogController, SettingsMessages, SettingsPage } from "./settingsShared";

export type { SettingsPage } from "./settingsShared";

import {
  ArchivedChatsSettings,
  DiagnosticsSettings,
  GeneralSettings,
  normalizeSearch,
  PersonalizationSettings,
  ProfileSettings,
  SettingsNavButton,
  ShortcutsSettings,
} from "./settingsSections";
import { UsageSettings } from "./settingsUsage";

interface SettingsNavigationItem {
  readonly icon: IconName;
  readonly label: string;
  readonly page: SettingsPage;
}

interface SettingsNavigationSection {
  readonly items: readonly SettingsNavigationItem[];
  readonly label: string;
}

function settingsNavigation(messages: SettingsMessages): readonly SettingsNavigationSection[] {
  return [
    {
      label: messages.personalSection,
      items: [
        { icon: "settings", label: messages.general, page: "general" },
        { icon: "bell", label: messages.notifications, page: "notifications" },
        { icon: "user", label: messages.profile, page: "profile" },
        { icon: "sparkles", label: messages.personalization, page: "personalization" },
        { icon: "keyboard", label: messages.shortcuts, page: "shortcuts" },
        { icon: "creditCard", label: messages.usageBilling, page: "usage" },
      ],
    },
    {
      label: messages.systemSection,
      items: [{ icon: "bug", label: messages.diagnostics, page: "diagnostics" }],
    },
    {
      label: messages.archivedSection,
      items: [{ icon: "archive", label: messages.archivedChats, page: "archived" }],
    },
  ];
}

export function SettingsDialog(props: {
  readonly controller: SettingsDialogController;
  readonly initialPage?: SettingsPage | undefined;
  readonly onClose: () => void;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const navigation = createMemo(() => settingsNavigation(messages()));
  const [page, setPage] = createSignal<SettingsPage>(props.initialPage ?? "general");
  const [query, setQuery] = createSignal("");
  const [developerInstructions, setDeveloperInstructions] = createSignal("");
  let dialogElement: HTMLElement | undefined;
  let settingsMainContentElement: HTMLDivElement | undefined;
  let settingsMainElement: HTMLElement | undefined;
  let previouslyFocusedElement: HTMLElement | null = null;
  const visibleNavigation = createMemo(() => {
    const normalizedQuery = normalizeSearch(query(), i18n.locale());
    if (normalizedQuery.length === 0) {
      return navigation();
    }
    return navigation()
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          normalizeSearch(item.label, i18n.locale()).includes(normalizedQuery),
        ),
      }))
      .filter((section) => section.items.length > 0);
  });

  createEffect(() => {
    setDeveloperInstructions(props.controller.config()?.config.developerInstructions ?? "");
  });

  onMount(() => {
    previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the dialog surface so the modal is announced without landing in search.
    queueMicrotask(() => dialogElement?.focus());
  });

  onCleanup(() => previouslyFocusedElement?.focus());

  function handleDialogKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || dialogElement === undefined) {
      return;
    }
    const focusable = [...dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) => element.getClientRects().length > 0,
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div class="settings-overlay">
      <section
        aria-label={messages().title}
        aria-modal="true"
        class="settings-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogElement}
        role="dialog"
        tabIndex={-1}
      >
        <aside class="settings-nav">
          <div class="settings-titlebar-slot">
            <button class="settings-back" onClick={props.onClose} type="button">
              <Icon name="arrowLeft" size={15} />
              <span>{messages().back}</span>
            </button>
          </div>
          <label class="settings-search">
            <Icon name="search" size={14} />
            <input
              aria-label={messages().search}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder={messages().searchPlaceholder}
              type="search"
              value={query()}
            />
          </label>
          <nav aria-label={messages().sections}>
            <For each={visibleNavigation()}>
              {(section) => (
                <section class="settings-nav-section">
                  <h2>{section.label}</h2>
                  <For each={section.items}>
                    {(item) => (
                      <SettingsNavButton
                        icon={item.icon}
                        label={item.label}
                        page={item.page}
                        selected={page()}
                        setPage={setPage}
                      />
                    )}
                  </For>
                </section>
              )}
            </For>
            <Show when={visibleNavigation().length === 0}>
              <p class="settings-search-empty">{messages().noResults}</p>
            </Show>
          </nav>
        </aside>
        <div class="settings-main-frame">
          <main class="settings-main" id="settings-main-scroll" ref={settingsMainElement}>
            <div class="settings-main-content" ref={settingsMainContentElement}>
              <Switch>
                <Match when={page() === "general"}>
                  <GeneralSettings controller={props.controller} />
                </Match>
                <Match when={page() === "personalization"}>
                  <PersonalizationSettings
                    controller={props.controller}
                    developerInstructions={developerInstructions()}
                    setDeveloperInstructions={setDeveloperInstructions}
                  />
                </Match>
                <Match when={page() === "notifications"}>
                  <NotificationSettings controller={props.controller} />
                </Match>
                <Match when={page() === "profile"}>
                  <ProfileSettings controller={props.controller} />
                </Match>
                <Match when={page() === "shortcuts"}>
                  <ShortcutsSettings />
                </Match>
                <Match when={page() === "usage"}>
                  <UsageSettings controller={props.controller} />
                </Match>
                <Match when={page() === "diagnostics"}>
                  <DiagnosticsSettings controller={props.controller} />
                </Match>
                <Match when={page() === "archived"}>
                  <ArchivedChatsSettings controller={props.controller} />
                </Match>
              </Switch>
            </div>
          </main>
          <SurfaceScrollbar
            className="settings-scrollbar"
            contentElement={() => settingsMainContentElement}
            controls="settings-main-scroll"
            label={messages().scrollArea}
            scrollElement={() => settingsMainElement}
          />
        </div>
      </section>
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
