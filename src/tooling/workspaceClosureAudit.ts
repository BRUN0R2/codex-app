export async function auditWorkspaceClosure() {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const waitUntil = async (predicate: () => boolean, label: string) => {
    const deadline = performance.now() + 5_000;
    while (!predicate()) {
      if (performance.now() >= deadline)
        throw new Error(`The workspace audit did not reach ${label}.`);
      await frame();
    }
  };
  const thread = [...document.querySelectorAll<HTMLButtonElement>(".thread-main")].find((entry) =>
    entry.textContent?.includes("Estresse de timeline expandida"),
  );
  if (thread === undefined) throw new Error("The workspace closure audit task is missing.");
  thread.click();
  await waitUntil(
    () =>
      document.getElementById("user-message-timeline-stress-user-message") !== null &&
      document.querySelector(".plan-review-trigger") !== null,
    "the selected review task",
  );
  const chat = document.querySelector<HTMLElement>(".chat-page");
  const review = document.querySelector<HTMLButtonElement>(".plan-review-trigger");
  if (chat === null || review === null) throw new Error("The review controls are missing.");
  const initialWidth = chat.getBoundingClientRect().width;
  review.click();
  await waitUntil(() => document.querySelector(".workspace-tab-close") !== null, "the review tab");
  const tabCount = document.querySelectorAll(".workspace-tab").length;
  const openedWidth = chat.getBoundingClientRect().width;
  const close = document.querySelector<HTMLButtonElement>(".workspace-tab-close");
  if (close === null) throw new Error("The review tab did not open.");
  close.click();
  await waitUntil(
    () =>
      document.querySelector(".workspace-panel") === null &&
      Math.abs(chat.getBoundingClientRect().width - initialWidth) <= 1,
    "the full conversation width",
  );
  return {
    tabCount,
    initialWidth,
    openedWidth,
    closedWidth: chat.getBoundingClientRect().width,
    panelPresent: document.querySelector(".workspace-panel") !== null,
    splitterPresent: document.querySelector(".workspace-splitter") !== null,
    expanded: document.querySelector(".workspace-panel-toggle")?.getAttribute("aria-expanded"),
  };
}
