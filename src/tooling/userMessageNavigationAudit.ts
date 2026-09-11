import { emitBrowserPreviewRuntimeEvent } from "../infrastructure/runtimeBridge";

export async function auditUserMessageNavigation() {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error("User-message navigation did not settle.");
      await frame();
    }
  };
  const thread = [...document.querySelectorAll<HTMLElement>(".thread-main")].find((element) =>
    element.textContent?.includes("Inspecionar janela de contexto"),
  );
  thread?.click();
  await waitUntil(() => document.querySelectorAll(".user-message-navigator button").length === 3);
  const timeline = document.querySelector<HTMLElement>(".timeline");
  if (timeline === null) throw new Error("The navigation timeline is missing.");
  const latestTurn = [...document.querySelectorAll(".conversation-turn")].at(-1);
  latestTurn?.querySelector<HTMLElement>(".agent-activity-group:not([open]) > summary")?.click();
  for (let index = 0; index < 8; index += 1) await frame();
  const samples: {
    readonly id: string;
    readonly visible: boolean;
    readonly hit: boolean;
    readonly intermediatePositions: number;
    readonly distance: number;
    readonly errorPx: number;
    readonly current: boolean;
  }[] = [];

  const navigate = async (index: number) => {
    const marker = document.querySelectorAll<HTMLButtonElement>(".user-message-navigator button")[
      index
    ];
    const id = marker?.getAttribute("aria-controls");
    if (marker === undefined || id === null || id === undefined) {
      throw new Error("A message marker has no navigation target.");
    }
    const bounds = marker.getBoundingClientRect();
    const visible = bounds.width > 0 && bounds.height > 0;
    const hit =
      visible && marker.contains(document.elementFromPoint(bounds.left + 4, bounds.top + 5));
    const initial = timeline.scrollTop;
    const positions = new Set<number>();
    let quietFrames = 0;
    let errorPx = Number.POSITIVE_INFINITY;
    marker.click();
    await waitUntil(() => {
      const target = document.getElementById(id);
      if (target === null) return false;
      const targetTop =
        timeline.scrollTop +
        target.getBoundingClientRect().top -
        timeline.getBoundingClientRect().top -
        32;
      const expected = Math.min(
        timeline.scrollHeight - timeline.clientHeight,
        Math.max(0, targetTop),
      );
      errorPx = Math.abs(timeline.scrollTop - expected);
      positions.add(timeline.scrollTop);
      quietFrames = errorPx <= 1 ? quietFrames + 1 : 0;
      return quietFrames >= 10;
    });
    const final = timeline.scrollTop;
    samples.push({
      id,
      visible,
      hit,
      errorPx,
      current: marker.getAttribute("aria-current") === "true",
      distance: Math.abs(final - initial),
      intermediatePositions: [...positions].filter(
        (position) => Math.abs(position - initial) > 1 && Math.abs(position - final) > 1,
      ).length,
    });
  };
  for (const index of [0, 2, 1, 2]) await navigate(index);

  document.querySelector<HTMLButtonElement>(".user-message-navigator button")?.click();
  for (let index = 0; index < 4; index += 1) await frame();
  timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 96 }));
  await frame();
  await frame();
  const interruptedTop = timeline.scrollTop;
  for (let index = 0; index < 16; index += 1) await frame();
  const cancellationDriftPx = Math.abs(timeline.scrollTop - interruptedTop);

  const liveId = "preview-live-navigation-user";
  if (
    !emitBrowserPreviewRuntimeEvent("engine://notification", {
      method: "item.started",
      params: {
        threadId: "preview-context-thread",
        turnId: "preview-active-turn",
        item: {
          type: "userMessage",
          id: liveId,
          content: [{ type: "text", text: "Mensagem recebida durante o trabalho." }],
        },
      },
    })
  )
    throw new Error("The preview did not receive the live user message.");
  await waitUntil(() => document.querySelectorAll(".user-message-navigator button").length === 4);
  await navigate(3);
  return {
    cancellationDriftPx,
    samples,
    liveMarkerCount: document.querySelectorAll(".user-message-navigator button").length,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}
