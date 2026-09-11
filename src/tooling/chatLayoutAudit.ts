async function settleChatLayout(frames = 8): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`The chat layout audit requires ${selector}.`);
  return element;
}

function updateDraft(value: string): void {
  const textarea = requiredElement<HTMLTextAreaElement>(".composer textarea");
  textarea.value = value;
  textarea.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value }),
  );
}

function openChatLayoutAuditThread(): void {
  const thread = [...document.querySelectorAll<HTMLButtonElement>(".thread-main")].find((entry) =>
    entry.textContent?.includes("Inspecionar janela de contexto"),
  );
  if (thread === undefined) throw new Error("The chat layout audit task is missing.");
  thread.click();
}

async function waitForTimelineEnd(): Promise<void> {
  const timeline = requiredElement<HTMLElement>(".timeline");
  const deadline = performance.now() + 5_000;
  while (Math.abs(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop) > 1) {
    if (performance.now() >= deadline) throw new Error("End navigation did not reach its target.");
    await settleChatLayout(1);
  }
  await settleChatLayout();
}

export async function auditComposerSizing() {
  await document.fonts.ready;
  openChatLayoutAuditThread();
  await settleChatLayout();
  const textarea = requiredElement<HTMLTextAreaElement>(".composer textarea");
  const composer = requiredElement<HTMLFormElement>(".composer");
  const measure = () => ({
    height: textarea.getBoundingClientRect().height,
    overflowing: textarea.scrollHeight > textarea.clientHeight + 1,
    characters: textarea.value.length,
  });
  const empty = measure();
  updateDraft("A short message");
  await settleChatLayout();
  const singleLine = measure();
  updateDraft("First line\nSecond line\nThird line\nFourth line\nFifth line");
  await settleChatLayout();
  const multiline = measure();
  const wrappedDraft = "A draft that reflows when the available width changes. ".repeat(5);
  updateDraft(wrappedDraft);
  await settleChatLayout();
  const wide = measure();
  composer.style.width = "300px";
  await settleChatLayout();
  const narrow = measure();
  composer.style.removeProperty("width");
  await settleChatLayout();
  const widened = measure();
  updateDraft("Pasted line\n".repeat(100));
  await settleChatLayout();
  const largePaste = measure();
  updateDraft("");
  await settleChatLayout();
  const cleared = measure();

  const savedDraft = "Saved draft line\n".repeat(8);
  updateDraft(savedDraft);
  await settleChatLayout();
  const saved = measure();
  requiredElement<HTMLButtonElement>(".new-thread-button").click();
  await settleChatLayout();
  const switched = measure();
  openChatLayoutAuditThread();
  await settleChatLayout();
  const restored = measure();
  const restoredDraftMatches = textarea.value === savedDraft;
  composer.requestSubmit();
  const deadline = performance.now() + 5_000;
  while (textarea.value !== "") {
    if (performance.now() >= deadline) throw new Error("The preview draft was not submitted.");
    await settleChatLayout(1);
  }
  await settleChatLayout();
  const submitted = measure();
  return {
    empty,
    singleLine,
    multiline,
    wide,
    narrow,
    widened,
    largePaste,
    cleared,
    saved,
    switched,
    restored,
    restoredDraftMatches,
    submitted,
    maximumHeight: Math.min(220, innerHeight / 4),
  };
}

export function prepareComposerFocusLoss(): number {
  const textarea = requiredElement<HTMLTextAreaElement>(".composer textarea");
  textarea.focus();
  updateDraft("Draft submitted while the window is unfocused\n".repeat(20));
  return textarea.getBoundingClientRect().height;
}

export async function submitComposerWhileUnfocused() {
  const textarea = requiredElement<HTMLTextAreaElement>(".composer textarea");
  const unfocused = !document.hasFocus();
  requiredElement<HTMLFormElement>(".composer").requestSubmit();
  const deadline = performance.now() + 5_000;
  while (textarea.value !== "") {
    if (performance.now() >= deadline)
      throw new Error("The unfocused preview draft did not clear.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return { unfocused, height: textarea.getBoundingClientRect().height };
}

export function measureTimelineEnd() {
  const timeline = requiredElement<HTMLElement>(".timeline");
  const track = requiredElement<HTMLElement>(".surface-scrollbar-track");
  const thumb = requiredElement<HTMLElement>(".surface-scrollbar-thumb");
  const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
  return {
    maximum,
    bottomGap: maximum - timeline.scrollTop,
    scrollbarMaximum: Number(track.getAttribute("aria-valuemax")),
    thumbGap: track.getBoundingClientRect().bottom - thumb.getBoundingClientRect().bottom,
    endButtonVisible: document.querySelector(".scroll-to-end-button") !== null,
    downDisabled: requiredElement<HTMLButtonElement>(".surface-scrollbar-arrow.down").disabled,
  };
}

export async function auditTimelineDockResize() {
  openChatLayoutAuditThread();
  await settleChatLayout();
  const timeline = requiredElement<HTMLElement>(".timeline");
  const track = requiredElement<HTMLElement>(".surface-scrollbar-track");
  track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
  await settleChatLayout();
  const initial = measureTimelineEnd();
  updateDraft("Expanded composer line\n".repeat(20));
  await settleChatLayout();
  const expanded = measureTimelineEnd();
  updateDraft("");
  await settleChatLayout();
  const cleared = measureTimelineEnd();

  track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
  await settleChatLayout();
  const detachedTop = timeline.scrollTop;
  updateDraft("Expanded while reading history\n".repeat(20));
  await settleChatLayout();
  const detachedDrift = Math.abs(timeline.scrollTop - detachedTop);
  requiredElement<HTMLButtonElement>(".scroll-to-end-button").click();
  await waitForTimelineEnd();
  const navigated = measureTimelineEnd();
  updateDraft("");
  await settleChatLayout();
  const clearedAfterNavigation = measureTimelineEnd();

  requiredElement<HTMLButtonElement>(".user-message-navigator button").click();
  const deadline = performance.now() + 3_000;
  while (document.querySelector(".scroll-to-end-button") === null) {
    if (performance.now() >= deadline) throw new Error("Message navigation did not leave the end.");
    await settleChatLayout(1);
  }
  requiredElement<HTMLButtonElement>(".scroll-to-end-button").click();
  await waitForTimelineEnd();
  const interruptedNavigation = measureTimelineEnd();
  return {
    initial,
    expanded,
    cleared,
    detachedDrift,
    navigated,
    clearedAfterNavigation,
    interruptedNavigation,
  };
}

export async function prepareTimelineEndInput(nearEnd: boolean) {
  const track = requiredElement<HTMLElement>(".surface-scrollbar-track");
  track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
  updateDraft("Draft resized before manual scrolling\n".repeat(20));
  await settleChatLayout();
  updateDraft("");
  await settleChatLayout();
  const timeline = requiredElement<HTMLElement>(".timeline");
  if (nearEnd) {
    timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight - 32;
    await settleChatLayout();
  }
  const thumbBounds = requiredElement<HTMLElement>(
    ".surface-scrollbar-thumb",
  ).getBoundingClientRect();
  const arrowBounds = requiredElement<HTMLElement>(
    ".surface-scrollbar-arrow.down",
  ).getBoundingClientRect();
  const timelineBounds = timeline.getBoundingClientRect();
  return {
    thumb: {
      x: thumbBounds.left + thumbBounds.width / 2,
      y: thumbBounds.top + thumbBounds.height / 2,
    },
    arrow: {
      x: arrowBounds.left + arrowBounds.width / 2,
      y: arrowBounds.top + arrowBounds.height / 2,
    },
    wheel: { x: timelineBounds.left + 8, y: timelineBounds.top + 100 },
    trackBottom: track.getBoundingClientRect().bottom - 1,
    scrollDistance: timeline.scrollHeight,
  };
}
