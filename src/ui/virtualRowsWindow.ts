interface VirtualRowsCanvasState {
  readonly window: VirtualRowsWindow;
}

export interface VirtualRowsRenderResult {
  readonly added: number;
  readonly canvas: HTMLTableSectionElement;
  readonly removed: number;
  readonly retained: number;
}

const canvasStates = new WeakMap<HTMLTableSectionElement, VirtualRowsCanvasState>();
const activityRootByCanvas = new WeakMap<HTMLTableSectionElement, HTMLElement>();
const canvasesByActivityRoot = new WeakMap<HTMLElement, Set<HTMLTableSectionElement>>();
const suspendedMountByCanvas = new WeakMap<HTMLTableSectionElement, HTMLTableElement>();

export class VirtualRowsWindow {
  readonly #activeCanvases = new Set<HTMLTableSectionElement>();
  readonly #className: string;
  readonly #owner: object;
  readonly #presentations: HTMLTableSectionElement[];
  readonly #rowBlueprints: ReadonlyMap<string, HTMLTableRowElement>;
  readonly #rowKeys: readonly string[];
  readonly #style: string | null;
  readonly #variant: string;

  constructor(input: {
    readonly owner: object;
    readonly template: HTMLTableSectionElement;
    readonly variant: string;
  }) {
    if (input.variant.length === 0) {
      throw new Error("Virtual row windows require a non-empty variant.");
    }
    this.#className = input.template.className;
    this.#owner = input.owner;
    this.#presentations = [input.template];
    this.#rowBlueprints = readRowsByKey(input.template, "template");
    this.#rowKeys = [...this.#rowBlueprints.keys()];
    this.#style = input.template.getAttribute("style");
    this.#variant = input.variant;
  }

  renderInto(canvas: HTMLTableSectionElement): VirtualRowsRenderResult {
    const previousState = canvasStates.get(canvas);
    if (previousState?.window === this) {
      return { added: 0, canvas, removed: 0, retained: canvas.childElementCount };
    }
    const suspendedMount = suspendedMountByCanvas.get(canvas);
    if (canvas.parentNode === null && suspendedMount === undefined) {
      throw new Error("A virtual row canvas must be attached before it can render.");
    }
    const compatible =
      previousState !== undefined &&
      previousState.window.#owner === this.#owner &&
      previousState.window.#variant === this.#variant;
    if (compatible) {
      const result = this.#reconcileRows(canvas);
      this.#synchronizeCanvasPresentation(canvas);
      previousState.window.#activeCanvases.delete(canvas);
      registerActivityCanvas(canvas);
      this.#activeCanvases.add(canvas);
      canvasStates.set(canvas, { window: this });
      return { ...result, canvas };
    }

    const incomingPresentation = this.#takePresentation();
    const result = {
      added: incomingPresentation.childElementCount,
      removed: canvas.childElementCount,
      retained: 0,
    };
    if (suspendedMount === undefined) {
      canvas.replaceWith(incomingPresentation);
    } else {
      suspendedMountByCanvas.delete(canvas);
      suspendedMountByCanvas.set(incomingPresentation, suspendedMount);
    }
    canvasStates.delete(canvas);
    if (previousState !== undefined) {
      previousState.window.#releasePresentation(canvas);
    }
    transferActivityCanvasRegistration(canvas, incomingPresentation);
    this.#activeCanvases.add(incomingPresentation);
    canvasStates.set(incomingPresentation, { window: this });
    return { ...result, canvas: incomingPresentation };
  }

  releaseCanvas(canvas: HTMLTableSectionElement): void {
    const state = canvasStates.get(canvas);
    if (state?.window !== this) {
      return;
    }
    canvasStates.delete(canvas);
    unregisterActivityCanvas(canvas);
    suspendedMountByCanvas.delete(canvas);
    canvas.remove();
    this.#activeCanvases.delete(canvas);
  }

  #reconcileRows(canvas: HTMLTableSectionElement): Omit<VirtualRowsRenderResult, "canvas"> {
    const currentRows = readRowsByKey(canvas, "canvas");
    let removed = 0;
    let retained = 0;
    for (const [key, row] of currentRows) {
      if (this.#rowBlueprints.has(key)) {
        retained += 1;
        continue;
      }
      row.remove();
      removed += 1;
    }

    let added = 0;
    let cursor: Element | null = canvas.firstElementChild;
    let pendingRows: DocumentFragment | null = null;
    for (const key of this.#rowKeys) {
      const existing = currentRows.get(key);
      if (existing?.parentElement === canvas) {
        if (pendingRows !== null) {
          canvas.insertBefore(pendingRows, existing);
          pendingRows = null;
        }
        if (existing !== cursor) {
          canvas.insertBefore(existing, cursor);
        }
        cursor = existing.nextElementSibling;
        continue;
      }
      const blueprint = this.#rowBlueprints.get(key);
      if (blueprint === undefined) {
        throw new Error(`A virtual row window lost blueprint ${key}.`);
      }
      pendingRows ??= document.createDocumentFragment();
      pendingRows.appendChild(blueprint.cloneNode(true));
      added += 1;
    }
    if (pendingRows !== null) {
      canvas.insertBefore(pendingRows, cursor);
    }
    return { added, removed, retained };
  }

  #createPresentation(): HTMLTableSectionElement {
    const presentation = document.createElement("tbody");
    this.#synchronizeCanvasPresentation(presentation);
    const fragment = document.createDocumentFragment();
    for (const key of this.#rowKeys) {
      const blueprint = this.#rowBlueprints.get(key);
      if (blueprint === undefined) {
        throw new Error(`A virtual row window lost blueprint ${key}.`);
      }
      fragment.appendChild(blueprint.cloneNode(true));
    }
    presentation.appendChild(fragment);
    return presentation;
  }

  #releasePresentation(presentation: HTMLTableSectionElement): void {
    this.#activeCanvases.delete(presentation);
    if (this.#presentations.length === 0) {
      this.#presentations.push(presentation);
      return;
    }
    presentation.remove();
  }

  #synchronizeCanvasPresentation(canvas: HTMLTableSectionElement): void {
    if (canvas.className !== this.#className) {
      canvas.className = this.#className;
    }
    if (this.#style === null) {
      canvas.removeAttribute("style");
    } else if (canvas.getAttribute("style") !== this.#style) {
      canvas.setAttribute("style", this.#style);
    }
  }

  #takePresentation(): HTMLTableSectionElement {
    return this.#presentations.pop() ?? this.#createPresentation();
  }
}

export function releaseVirtualRowsCanvas(canvas: HTMLTableSectionElement): void {
  canvasStates.get(canvas)?.window.releaseCanvas(canvas);
}

export function resumeVirtualRowsCanvases(root: HTMLElement): void {
  for (const canvas of canvasesByActivityRoot.get(root) ?? []) {
    const mount = suspendedMountByCanvas.get(canvas);
    if (mount === undefined) {
      continue;
    }
    suspendedMountByCanvas.delete(canvas);
    mount.appendChild(canvas);
  }
}

export function suspendVirtualRowsCanvases(root: HTMLElement): void {
  for (const canvas of canvasesByActivityRoot.get(root) ?? []) {
    if (!canvasStates.has(canvas) || suspendedMountByCanvas.has(canvas)) {
      continue;
    }
    const mount = canvas.parentElement;
    if (!(mount instanceof HTMLTableElement)) {
      throw new Error("A virtual row canvas lost its table mount.");
    }
    canvas.remove();
    suspendedMountByCanvas.set(canvas, mount);
  }
}

function transferActivityCanvasRegistration(
  previousCanvas: HTMLTableSectionElement,
  nextCanvas: HTMLTableSectionElement,
): void {
  const root =
    activityRootByCanvas.get(previousCanvas) ??
    nextCanvas.closest<HTMLElement>(".agent-activity-render-slot") ??
    previousCanvas.closest<HTMLElement>(".agent-activity-render-slot");
  if (root === null || root === undefined) {
    return;
  }
  let canvases = canvasesByActivityRoot.get(root);
  if (canvases === undefined) {
    canvases = new Set();
    canvasesByActivityRoot.set(root, canvases);
  }
  canvases.delete(previousCanvas);
  canvases.add(nextCanvas);
  activityRootByCanvas.delete(previousCanvas);
  activityRootByCanvas.set(nextCanvas, root);
}

function registerActivityCanvas(canvas: HTMLTableSectionElement): void {
  if (activityRootByCanvas.has(canvas)) {
    return;
  }
  const root = canvas.closest<HTMLElement>(".agent-activity-render-slot");
  if (root === null) {
    return;
  }
  let canvases = canvasesByActivityRoot.get(root);
  if (canvases === undefined) {
    canvases = new Set();
    canvasesByActivityRoot.set(root, canvases);
  }
  canvases.add(canvas);
  activityRootByCanvas.set(canvas, root);
}

function unregisterActivityCanvas(canvas: HTMLTableSectionElement): void {
  const root = activityRootByCanvas.get(canvas);
  if (root === undefined) {
    return;
  }
  activityRootByCanvas.delete(canvas);
  const canvases = canvasesByActivityRoot.get(root);
  canvases?.delete(canvas);
  if (canvases?.size === 0) {
    canvasesByActivityRoot.delete(root);
  }
}

function readRowsByKey(
  section: HTMLTableSectionElement,
  source: "canvas" | "template",
): Map<string, HTMLTableRowElement> {
  const rows = new Map<string, HTMLTableRowElement>();
  for (const child of section.children) {
    if (child.tagName !== "TR") {
      throw new Error(`A virtual row ${source} contains a non-row element.`);
    }
    const row = child as HTMLTableRowElement;
    const key = row.getAttribute("aria-rowindex");
    if (key === null || key.length === 0) {
      throw new Error(`A virtual row ${source} is missing its semantic key.`);
    }
    if (rows.has(key)) {
      throw new Error(`A virtual row ${source} contains duplicate key ${key}.`);
    }
    rows.set(key, row);
  }
  return rows;
}
