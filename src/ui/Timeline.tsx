import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type {
  ActivityStatus,
  FileChange,
  ThreadItem,
  UserContent,
  VisibleThreadItem,
} from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { projectName } from "../state/projects";
import type { VisibleThreadTurn } from "../state/threadRuntime";
import { CodexGlyph } from "./CodexGlyph";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import {
  calculateTimelineScrollbar,
  isTimelineNearEnd,
  type ScrollbarMetrics,
} from "./timelineScroll";
import { presentTurnFailure } from "./turnFailure";

interface StarterSuggestion {
  readonly icon: "edit" | "file" | "search" | "terminal";
  readonly label: string;
  readonly prompt: string;
  readonly tone: "blue" | "green" | "orange" | "violet";
}

const STARTER_SUGGESTIONS: readonly StarterSuggestion[] = [
  {
    icon: "search",
    label: "Explore e entenda o código",
    prompt:
      "Explore este projeto e explique sua arquitetura, os fluxos principais e os riscos técnicos mais importantes.",
    tone: "blue",
  },
  {
    icon: "edit",
    label: "Crie um novo recurso, aplicativo ou ferramenta",
    prompt:
      "Implemente um novo recurso neste projeto. Primeiro identifique a melhor integração arquitetural e então faça a alteração completa com validação.",
    tone: "violet",
  },
  {
    icon: "file",
    label: "Revise código e sugira mudanças",
    prompt:
      "Revise as alterações atuais do projeto, priorize bugs, riscos e regressões e proponha correções objetivas.",
    tone: "green",
  },
  {
    icon: "terminal",
    label: "Corrija problemas e falhas",
    prompt:
      "Investigue os problemas atuais do projeto, encontre a causa raiz e implemente uma correção completa e verificável.",
    tone: "orange",
  },
];

const USER_MESSAGE_COLLAPSED_LINES = 20;

interface UserMessageEntry {
  readonly id: string;
  readonly label: string;
}

export function Timeline(props: {
  readonly controller: AppController;
  readonly onSelectSuggestion: (prompt: string) => void;
}) {
  let scrollElement: HTMLDivElement | undefined;
  let contentElement: HTMLDivElement | undefined;
  let scrollbarTrackElement: HTMLDivElement | undefined;
  let scrollbarThumbElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animationFrame: number | undefined;
  let dragState:
    | { readonly pointerId: number; readonly startScrollTop: number; readonly startY: number }
    | undefined;
  const [followingLatest, setFollowingLatest] = createSignal(true);
  const [showScrollToEnd, setShowScrollToEnd] = createSignal(false);
  const [activeUserMessageIndex, setActiveUserMessageIndex] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const [scrollbar, setScrollbar] = createSignal<ScrollbarMetrics>({
    maximumScroll: 0,
    scrollable: false,
    thumbHeight: 0,
    thumbTop: 0,
  });
  const userMessages = createMemo<readonly UserMessageEntry[]>(() =>
    props.controller
      .turns()
      .flatMap((turn) =>
        turn.items.flatMap((item) =>
          item.type === "userMessage"
            ? [{ id: item.id, label: userMessagePreview(item.content) }]
            : [],
        ),
      ),
  );

  function measureActiveUserMessage(): void {
    if (scrollElement === undefined || userMessages().length === 0) {
      setActiveUserMessageIndex(0);
      return;
    }
    const viewportTop = scrollElement.getBoundingClientRect().top + 112;
    let activeIndex = 0;
    for (const [index, message] of userMessages().entries()) {
      const element = document.getElementById(userMessageAnchor(message.id));
      if (element === null || element.getBoundingClientRect().top > viewportTop) {
        break;
      }
      activeIndex = index;
    }
    setActiveUserMessageIndex(activeIndex);
  }

  function measureScroll(userInitiated: boolean): void {
    if (scrollElement === undefined) {
      return;
    }
    const trackHeight = scrollbarTrackElement?.clientHeight ?? 0;
    setScrollbar(
      calculateTimelineScrollbar({
        clientHeight: scrollElement.clientHeight,
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
        trackHeight,
      }),
    );
    const isNearEnd = isTimelineNearEnd({
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
    });
    setShowScrollToEnd(!isNearEnd);
    if (userInitiated) {
      setFollowingLatest(isNearEnd);
    }
    measureActiveUserMessage();
  }

  function synchronizeScroll(): void {
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      if (scrollElement === undefined) {
        return;
      }
      if (followingLatest()) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
      measureScroll(false);
    });
  }

  function scrollToEnd(behavior: ScrollBehavior = "auto"): void {
    if (scrollElement === undefined) {
      return;
    }
    setFollowingLatest(true);
    scrollElement.scrollTo({ behavior, top: scrollElement.scrollHeight });
    if (behavior === "auto") {
      measureScroll(false);
    }
  }

  function scrollToUserMessage(message: UserMessageEntry): void {
    if (scrollElement === undefined) {
      return;
    }
    const element = document.getElementById(userMessageAnchor(message.id));
    if (element === null) {
      return;
    }
    setFollowingLatest(false);
    scrollElement.scrollTo({ behavior: "smooth", top: Math.max(0, element.offsetTop - 32) });
  }

  function setScrollTopFromThumb(thumbTop: number, userInitiated: boolean): void {
    if (scrollElement === undefined || scrollbarTrackElement === undefined) {
      return;
    }
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, scrollbarTrackElement.clientHeight - metrics.thumbHeight);
    scrollElement.scrollTop =
      maximumThumbTop === 0
        ? 0
        : (Math.min(maximumThumbTop, Math.max(0, thumbTop)) / maximumThumbTop) *
          metrics.maximumScroll;
    measureScroll(userInitiated);
  }

  function handleScrollbarTrackPointerDown(event: PointerEvent): void {
    if (
      event.target === scrollbarThumbElement ||
      scrollbarTrackElement === undefined ||
      !scrollbar().scrollable
    ) {
      return;
    }
    event.preventDefault();
    const track = scrollbarTrackElement.getBoundingClientRect();
    setScrollTopFromThumb(event.clientY - track.top - scrollbar().thumbHeight / 2, true);
  }

  function handleScrollbarThumbPointerDown(event: PointerEvent): void {
    if (scrollElement === undefined || scrollbarThumbElement === undefined) {
      return;
    }
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startScrollTop: scrollElement.scrollTop,
      startY: event.clientY,
    };
    scrollbarThumbElement.setPointerCapture(event.pointerId);
  }

  function handleScrollbarThumbPointerMove(event: PointerEvent): void {
    if (
      dragState === undefined ||
      dragState.pointerId !== event.pointerId ||
      scrollbarTrackElement === undefined
    ) {
      return;
    }
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, scrollbarTrackElement.clientHeight - metrics.thumbHeight);
    const scrollDelta =
      maximumThumbTop === 0
        ? 0
        : ((event.clientY - dragState.startY) / maximumThumbTop) * metrics.maximumScroll;
    const targetScrollTop = dragState.startScrollTop + scrollDelta;
    const targetThumbTop =
      metrics.maximumScroll === 0 ? 0 : (targetScrollTop / metrics.maximumScroll) * maximumThumbTop;
    setScrollTopFromThumb(targetThumbTop, true);
  }

  function handleScrollbarThumbPointerUp(event: PointerEvent): void {
    if (dragState?.pointerId !== event.pointerId || scrollbarThumbElement === undefined) {
      return;
    }
    scrollbarThumbElement.releasePointerCapture(event.pointerId);
    dragState = undefined;
  }

  function handleScrollbarKeyDown(event: KeyboardEvent): void {
    if (scrollElement === undefined) {
      return;
    }
    const page = Math.max(120, scrollElement.clientHeight * 0.8);
    switch (event.key) {
      case "ArrowDown":
        scrollElement.scrollBy({ top: 64 });
        break;
      case "ArrowUp":
        scrollElement.scrollBy({ top: -64 });
        break;
      case "End":
        scrollToEnd();
        break;
      case "Home":
        scrollElement.scrollTop = 0;
        break;
      case "PageDown":
        scrollElement.scrollBy({ top: page });
        break;
      case "PageUp":
        scrollElement.scrollBy({ top: -page });
        break;
      default:
        return;
    }
    event.preventDefault();
    measureScroll(true);
  }

  onMount(() => {
    if (scrollElement === undefined || contentElement === undefined) {
      return;
    }
    const handleScroll = () => measureScroll(true);
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    resizeObserver = new ResizeObserver(synchronizeScroll);
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(contentElement);
    if (scrollbarTrackElement !== undefined) {
      resizeObserver.observe(scrollbarTrackElement);
    }
    synchronizeScroll();
    const clockInterval = window.setInterval(() => setClock(Date.now()), 1_000);
    onCleanup(() => window.clearInterval(clockInterval));
    onCleanup(() => scrollElement?.removeEventListener("scroll", handleScroll));
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
  });

  createEffect(() => {
    props.controller.turns();
    props.controller.turnBusy();
    synchronizeScroll();
  });

  return (
    <div class="timeline-frame">
      <UserMessageNavigator
        activeIndex={activeUserMessageIndex()}
        messages={userMessages()}
        onSelect={scrollToUserMessage}
      />
      <section
        aria-label="Conversa"
        class="timeline"
        id="conversation-timeline"
        ref={scrollElement}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the official desktop keeps the scroll viewport keyboard-focusable for Home, End, PageUp, and PageDown.
        tabIndex={0}
      >
        <div class="timeline-inner" ref={contentElement}>
          <Show
            when={props.controller.turns().length > 0}
            fallback={
              <EmptyConversation
                onSelectSuggestion={props.onSelectSuggestion}
                workspace={props.controller.workspace()}
              />
            }
          >
            <For each={props.controller.turns()}>
              {(turn) => <ConversationTurn clock={clock()} turn={turn} />}
            </For>
          </Show>
        </div>
      </section>
      <div
        aria-controls="conversation-timeline"
        aria-hidden={!scrollbar().scrollable}
        aria-label="Posição na conversa"
        aria-orientation="vertical"
        aria-valuemax={Math.round(scrollbar().maximumScroll)}
        aria-valuemin={0}
        aria-valuenow={Math.round(scrollElement?.scrollTop ?? 0)}
        class="timeline-scrollbar"
        classList={{ "is-hidden": !scrollbar().scrollable }}
        onKeyDown={handleScrollbarKeyDown}
        onPointerDown={handleScrollbarTrackPointerDown}
        ref={scrollbarTrackElement}
        role="scrollbar"
        tabIndex={scrollbar().scrollable ? 0 : -1}
      >
        <div
          class="timeline-scrollbar-thumb"
          onPointerDown={handleScrollbarThumbPointerDown}
          onPointerMove={handleScrollbarThumbPointerMove}
          onPointerUp={handleScrollbarThumbPointerUp}
          ref={scrollbarThumbElement}
          style={{
            height: `${scrollbar().thumbHeight}px`,
            transform: `translateY(${scrollbar().thumbTop}px)`,
          }}
        />
      </div>
      <Show when={showScrollToEnd()}>
        <button
          aria-label="Ir para o fim da conversa"
          class="scroll-to-end-button"
          onClick={() => scrollToEnd("smooth")}
          title="Ir para o fim da conversa"
          type="button"
        >
          <Icon name="chevronDown" size={16} />
        </button>
      </Show>
    </div>
  );
}

function UserMessageNavigator(props: {
  readonly activeIndex: number;
  readonly messages: readonly UserMessageEntry[];
  readonly onSelect: (message: UserMessageEntry) => void;
}) {
  return (
    <Show when={props.messages.length > 1}>
      <nav aria-label="Mensagens do usuário" class="user-message-navigator">
        <For each={props.messages}>
          {(message, index) => (
            <button
              aria-current={index() === props.activeIndex ? "true" : undefined}
              aria-label={`Ir para a mensagem do usuário ${index() + 1}`}
              classList={{ active: index() === props.activeIndex }}
              onClick={() => props.onSelect(message)}
              title={message.label}
              type="button"
            >
              <span class="user-message-navigator-dot" />
              <span class="user-message-navigator-preview">{message.label}</span>
            </button>
          )}
        </For>
      </nav>
    </Show>
  );
}

function ConversationTurn(props: { readonly clock: number; readonly turn: VisibleThreadTurn }) {
  const failure = () => (props.turn.error === null ? null : presentTurnFailure(props.turn.error));
  return (
    <section class="conversation-turn" data-status={props.turn.status}>
      <For each={props.turn.items}>{(item) => <TimelineItem item={item} />}</For>
      <Show when={failure()}>
        {(presentation) => (
          <section class="turn-failure" role="alert">
            <strong>{presentation().title}</strong>
            <p>{presentation().detail}</p>
            <Show when={presentation().technical}>
              {(technical) => <small>{technical()}</small>}
            </Show>
          </section>
        )}
      </Show>
      <TurnDuration clock={props.clock} turn={props.turn} />
    </section>
  );
}

function TurnDuration(props: { readonly clock: number; readonly turn: VisibleThreadTurn }) {
  const label = () => {
    const end =
      props.turn.status === "inProgress"
        ? Math.floor(props.clock / 1_000)
        : Math.max(props.turn.createdAt, props.turn.updatedAt);
    const duration = formatElapsedSeconds(Math.max(0, end - props.turn.createdAt));
    switch (props.turn.status) {
      case "completed":
        return `Trabalhou por ${duration}`;
      case "failed":
        return `Falhou após ${duration}`;
      case "inProgress":
        return `Trabalhando há ${duration}`;
      case "interrupted":
        return `Você interrompeu após ${duration}`;
    }
  };

  return (
    <div class="turn-duration" role={props.turn.status === "inProgress" ? "status" : undefined}>
      <span>{label()}</span>
      <i />
    </div>
  );
}

function EmptyConversation(props: {
  readonly onSelectSuggestion: (prompt: string) => void;
  readonly workspace: string | null;
}) {
  return (
    <section aria-labelledby="empty-conversation-title" class="empty-conversation">
      <div class="empty-orb">
        <CodexGlyph />
      </div>
      <h2 id="empty-conversation-title">
        O que devemos criar
        <Show when={props.workspace} fallback="?">
          {(workspace) => (
            <>
              {" em "}
              <span>{projectName(workspace())}</span>?
            </>
          )}
        </Show>
      </h2>
      <fieldset class="starter-suggestions">
        <legend class="visually-hidden">Sugestões para começar</legend>
        <For each={STARTER_SUGGESTIONS}>
          {(suggestion) => (
            <button
              data-tone={suggestion.tone}
              onClick={() => props.onSelectSuggestion(suggestion.prompt)}
              type="button"
            >
              <Icon name={suggestion.icon} size={17} />
              <span>{suggestion.label}</span>
            </button>
          )}
        </For>
      </fieldset>
    </section>
  );
}

function TimelineItem(props: { readonly item: VisibleThreadItem }) {
  switch (props.item.type) {
    case "userMessage":
      return <UserMessage item={props.item} />;
    case "agentMessage":
      return <AgentMessage item={props.item} />;
    case "contextCompaction":
      return <ContextCompaction item={props.item} />;
    case "reasoning":
      return <Reasoning item={props.item} />;
    case "commandExecution":
      return <CommandItem item={props.item} />;
    case "fileChange":
      return <FileChangeItem item={props.item} />;
    case "toolExecution":
      return <ToolItem item={props.item} />;
  }
}

function ContextCompaction(props: {
  readonly item: Extract<ThreadItem, { type: "contextCompaction" }>;
}) {
  return (
    <section class="context-compaction-row" id={props.item.id}>
      <span class="activity-icon">
        <Icon name="layers" size={15} />
      </span>
      <span>Contexto compactado</span>
      <small>A conversa continua em uma nova janela de contexto.</small>
    </section>
  );
}

function UserMessage(props: { readonly item: Extract<ThreadItem, { type: "userMessage" }> }) {
  let bubble: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const [collapsible, setCollapsible] = createSignal(false);

  function measure(): void {
    if (bubble === undefined || expanded()) {
      return;
    }
    setCollapsible(bubble.scrollHeight > bubble.clientHeight + 1);
  }

  onMount(() => {
    resizeObserver = new ResizeObserver(measure);
    if (bubble !== undefined) {
      resizeObserver.observe(bubble);
    }
    queueMicrotask(measure);
  });
  onCleanup(() => resizeObserver?.disconnect());

  return (
    <article class="message-row user-message-row" id={userMessageAnchor(props.item.id)}>
      <div class="message-content">
        <span class="visually-hidden">Você disse:</span>
        <div
          class="user-message-bubble"
          classList={{ clamped: !expanded(), collapsed: collapsible() && !expanded() }}
          ref={bubble}
          style={{ "--collapsed-lines": USER_MESSAGE_COLLAPSED_LINES }}
        >
          <For each={props.item.content}>{(content) => <UserContentPart content={content} />}</For>
        </div>
        <Show when={collapsible()}>
          <button
            aria-expanded={expanded()}
            class="user-message-expand"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded() ? "Mostrar menos" : "Mostrar mais"}
          </button>
        </Show>
        <div class="message-actions user-message-actions">
          <CopyMessageButton text={userMessageCopyText(props.item.content)} />
        </div>
      </div>
    </article>
  );
}

function UserContentPart(props: { readonly content: UserContent }) {
  switch (props.content.type) {
    case "text":
      return <p class="message-text">{props.content.text}</p>;
    case "localImage":
      return (
        <div class="attachment-line">
          <Icon name="file" size={15} /> Imagem: {fileName(props.content.path)}
        </div>
      );
    case "mention":
      return (
        <div class="attachment-line">
          <Icon name="file" size={15} /> {props.content.name}
        </div>
      );
  }
}

function AgentMessage(props: { readonly item: Extract<ThreadItem, { type: "agentMessage" }> }) {
  return (
    <article
      class="message-row agent-message-row"
      classList={{ commentary: props.item.phase === "commentary" }}
    >
      <div class="message-content">
        <span class="visually-hidden">Codex disse:</span>
        <Show when={props.item.phase === "commentary"}>
          <div class="message-phase">Atualização</div>
        </Show>
        <Markdown class="agent-message-markdown" text={props.item.text} />
        <div class="message-actions">
          <CopyMessageButton text={props.item.text} />
        </div>
      </div>
    </article>
  );
}

function CopyMessageButton(props: { readonly text: string }) {
  const [state, setState] = createSignal<"copied" | "failed" | "idle">("idle");
  let resetTimer: number | undefined;

  onCleanup(() => window.clearTimeout(resetTimer));

  async function copy(): Promise<void> {
    window.clearTimeout(resetTimer);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(props.text);
      setState("copied");
    } catch {
      setState("failed");
    }
    resetTimer = window.setTimeout(() => setState("idle"), 2_000);
  }

  const label = () => {
    switch (state()) {
      case "copied":
        return "Copiado";
      case "failed":
        return "Falha ao copiar";
      case "idle":
        return "Copiar";
    }
  };

  return (
    <button
      aria-label={label()}
      aria-live="polite"
      class="message-copy-button"
      disabled={props.text.length === 0}
      onClick={() => void copy()}
      title={label()}
      type="button"
    >
      <Icon name={state() === "copied" ? "check" : "copy"} size={14} />
      <span class="visually-hidden">{label()}</span>
    </button>
  );
}

function Reasoning(props: { readonly item: Extract<ThreadItem, { type: "reasoning" }> }) {
  const summary = () => props.item.summary.filter(Boolean).join("\n");
  const content = () => props.item.content.filter(Boolean).join("\n");
  return (
    <details class="activity-card reasoning-card">
      <summary>
        <span class="activity-icon">
          <Icon name="bot" size={15} />
        </span>
        <span>Raciocínio</span>
        <small>{summary().split("\n")[0] || "Analisando contexto"}</small>
      </summary>
      <Show when={summary().length > 0}>
        <pre>{summary()}</pre>
      </Show>
      <Show when={content().length > 0}>
        <pre>{content()}</pre>
      </Show>
    </details>
  );
}

function CommandItem(props: { readonly item: Extract<ThreadItem, { type: "commandExecution" }> }) {
  return (
    <details
      class={`activity-card status-${props.item.status}`}
      open={props.item.status === "failed"}
    >
      <summary>
        <span class="activity-icon">
          <Icon name="terminal" size={15} />
        </span>
        <span>Comando</span>
        <code>{props.item.command}</code>
        <StatusPill status={props.item.status} />
      </summary>
      <div class="activity-meta">
        <span>{props.item.cwd}</span>
        <Show when={props.item.durationMs !== null}>
          <span>{formatDuration(props.item.durationMs ?? 0)}</span>
        </Show>
        <Show when={props.item.exitCode !== null}>
          <span>exit {props.item.exitCode}</span>
        </Show>
      </div>
      <Show when={props.item.aggregatedOutput !== null}>
        <pre class="terminal-output">{props.item.aggregatedOutput}</pre>
      </Show>
    </details>
  );
}

function FileChangeItem(props: { readonly item: Extract<ThreadItem, { type: "fileChange" }> }) {
  return (
    <section class={`activity-card file-change-card status-${props.item.status}`}>
      <header>
        <span class="activity-icon">
          <Icon name="file" size={15} />
        </span>
        <strong>Alterações em arquivos</strong>
        <StatusPill status={props.item.status} />
      </header>
      <For each={props.item.changes}>{(change) => <Change change={change} />}</For>
    </section>
  );
}

function Change(props: { readonly change: FileChange }) {
  return (
    <details class="diff-block">
      <summary>
        <span class={`change-kind kind-${props.change.kind.type}`}>
          {changeLabel(props.change)}
        </span>
        <code>{props.change.path}</code>
      </summary>
      <pre>
        <For each={props.change.diff.split("\n")}>
          {(line) => (
            <span classList={{ added: line.startsWith("+"), removed: line.startsWith("-") }}>
              {line}
              {"\n"}
            </span>
          )}
        </For>
      </pre>
    </details>
  );
}

function ToolItem(props: { readonly item: Extract<ThreadItem, { type: "toolExecution" }> }) {
  return (
    <details class={`activity-card status-${props.item.status}`}>
      <summary>
        <span class="activity-icon">
          <Icon name="shield" size={15} />
        </span>
        <span>{toolLabel(props.item.name)}</span>
        <small>{props.item.description}</small>
        <StatusPill status={props.item.status} />
      </summary>
      <Show when={props.item.output !== null}>
        <pre>{props.item.output}</pre>
      </Show>
    </details>
  );
}

function StatusPill(props: { readonly status: ActivityStatus }) {
  return <span class={`status-pill status-${props.status}`}>{statusLabel(props.status)}</span>;
}

function statusLabel(status: ActivityStatus): string {
  switch (status) {
    case "completed":
      return "Concluído";
    case "declined":
      return "Recusado";
    case "failed":
      return "Falhou";
    case "inProgress":
      return "Em andamento";
  }
}

function toolLabel(name: string): string {
  switch (name) {
    case "read_file":
      return "Leitura de arquivo";
    case "list_files":
      return "Listagem de arquivos";
    case "search_text":
      return "Busca no projeto";
    case "web_search":
      return "Pesquisa na web";
    default:
      return name;
  }
}

function changeLabel(change: FileChange): string {
  switch (change.kind.type) {
    case "add":
      return "NOVO";
    case "delete":
      return "EXCLUÍDO";
    case "update":
      return "ALTERADO";
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function userMessageCopyText(content: readonly UserContent[]): string {
  return content.map(userContentPartCopyText).join("\n");
}

function userMessagePreview(content: readonly UserContent[]): string {
  const text = userMessageCopyText(content).replace(/\s+/gu, " ").trim();
  return text.length <= 72 ? text || "Mensagem sem texto" : `${text.slice(0, 69)}…`;
}

function userMessageAnchor(id: string): string {
  return `user-message-${id}`;
}

function userContentPartCopyText(part: UserContent): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "localImage":
      return `Imagem: ${fileName(part.path)}`;
    case "mention":
      return part.name;
  }
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 1) {
    return "menos de 1s";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}min` : `${minutes}min ${remainder}s`;
  }
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
}
