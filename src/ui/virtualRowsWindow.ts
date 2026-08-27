interface VirtualRowsCanvasState {
  readonly window: VirtualRowsWindow;
}

export type VirtualRowsCanvas = HTMLDivElement;

type VirtualRowsMount = HTMLDivElement;
type VirtualRowsRow = HTMLDivElement;

const VIRTUAL_ROWS_MOUNT_ROLE = "table";
const VIRTUAL_ROWS_CANVAS_ROLE = "rowgroup";
const VIRTUAL_ROW_ROLE = "row";

export interface VirtualRowsRenderResult {
  readonly added: number;
  readonly canvas: VirtualRowsCanvas;
  readonly removed: number;
  readonly retained: number;
}

export function createFixedVirtualRowsCanvas(input: {
  readonly className: string;
  readonly firstRowTop: number;
  readonly rowHeight: number;
  readonly rowMarkup: string;
  readonly totalHeight: number;
}): VirtualRowsCanvas {
  if (!Number.isFinite(input.firstRowTop) || input.firstRowTop < 0) {
    throw new Error("A virtual row canvas requires a non-negative finite first-row offset.");
  }
  if (!Number.isFinite(input.rowHeight) || input.rowHeight <= 0) {
    throw new Error("A virtual row canvas requires a positive finite row height.");
  }
  if (!Number.isFinite(input.totalHeight) || input.totalHeight < 0) {
    throw new Error("A virtual row canvas requires a non-negative finite total height.");
  }

  const template = document.createElement("template");
  template.innerHTML = input.rowMarkup;
  const rows = [...template.content.children];
  const canvas = document.createElement("div");
  canvas.className = input.className;
  canvas.setAttribute("role", VIRTUAL_ROWS_CANVAS_ROLE);
  canvas.style.height = `${input.totalHeight}px`;

  for (const [index, candidate] of rows.entries()) {
    if (
      !(candidate instanceof HTMLDivElement) ||
      candidate.getAttribute("role") !== VIRTUAL_ROW_ROLE
    ) {
      throw new Error(`A virtual row template contains an invalid row at index ${index}.`);
    }
    candidate.style.top = `${Math.round(input.firstRowTop + index * input.rowHeight)}px`;
  }
  canvas.append(template.content);
  return canvas;
}

const canvasStates = new WeakMap<VirtualRowsCanvas, VirtualRowsCanvasState>();
const activityRootByCanvas = new WeakMap<VirtualRowsCanvas, HTMLElement>();
const canvasesByActivityRoot = new WeakMap<HTMLElement, Set<VirtualRowsCanvas>>();
const suspendedMountByCanvas = new WeakMap<VirtualRowsCanvas, VirtualRowsMount>();

export class VirtualRowsWindow {
  readonly #activeCanvases = new Set<VirtualRowsCanvas>();
  readonly #className: string;
  readonly #owner: object;
  readonly #presentations: VirtualRowsCanvas[];
  readonly #rowBlueprints: ReadonlyMap<string, VirtualRowsRow>;
  readonly #rowKeys: readonly string[];
  readonly #height: string;
  readonly #variant: string;

  constructor(input: {
    readonly owner: object;
    readonly template: VirtualRowsCanvas;
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
    this.#height = input.template.style.height;
    if (this.#height.length === 0) {
      throw new Error("A virtual row window requires an explicit canvas height.");
    }
    this.#variant = input.variant;
  }

  renderInto(canvas: VirtualRowsCanvas): VirtualRowsRenderResult {
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

  releaseCanvas(canvas: VirtualRowsCanvas): void {
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

  #reconcileRows(canvas: VirtualRowsCanvas): Omit<VirtualRowsRenderResult, "canvas"> {
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
        const blueprint = this.#rowBlueprints.get(key);
        if (blueprint === undefined) {
          throw new Error(`A virtual row window lost blueprint ${key}.`);
        }
        synchronizeVirtualRowPosition(existing, blueprint);
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
      pendingRows.appendChild(cloneVirtualRow(blueprint));
      added += 1;
    }
    if (pendingRows !== null) {
      canvas.insertBefore(pendingRows, cursor);
    }
    return { added, removed, retained };
  }

  #createPresentation(): VirtualRowsCanvas {
    const presentation = document.createElement("div");
    this.#synchronizeCanvasPresentation(presentation);
    const fragment = document.createDocumentFragment();
    for (const key of this.#rowKeys) {
      const blueprint = this.#rowBlueprints.get(key);
      if (blueprint === undefined) {
        throw new Error(`A virtual row window lost blueprint ${key}.`);
      }
      fragment.appendChild(cloneVirtualRow(blueprint));
    }
    presentation.appendChild(fragment);
    return presentation;
  }

  #releasePresentation(presentation: VirtualRowsCanvas): void {
    this.#activeCanvases.delete(presentation);
    if (this.#presentations.length === 0) {
      this.#presentations.push(presentation);
      return;
    }
    presentation.remove();
  }

  #synchronizeCanvasPresentation(canvas: VirtualRowsCanvas): void {
    if (canvas.className !== this.#className) {
      canvas.className = this.#className;
    }
    if (canvas.getAttribute("role") !== VIRTUAL_ROWS_CANVAS_ROLE) {
      canvas.setAttribute("role", VIRTUAL_ROWS_CANVAS_ROLE);
    }
    if (canvas.style.height !== this.#height) {
      canvas.style.height = this.#height;
    }
  }

  #takePresentation(): VirtualRowsCanvas {
    return this.#presentations.pop() ?? this.#createPresentation();
  }
}

function cloneVirtualRow(blueprint: VirtualRowsRow): VirtualRowsRow {
  const clone = blueprint.cloneNode(true);
  if (!(clone instanceof HTMLDivElement)) {
    throw new Error("A virtual row blueprint produced an invalid clone.");
  }
  clone.removeAttribute("style");
  synchronizeVirtualRowPosition(clone, blueprint);
  return clone;
}

function synchronizeVirtualRowPosition(row: VirtualRowsRow, blueprint: VirtualRowsRow): void {
  const top = blueprint.style.top;
  if (top.length === 0) {
    throw new Error("A virtual row blueprint is missing its fixed position.");
  }
  row.style.top = top;
}

export function releaseVirtualRowsCanvas(canvas: VirtualRowsCanvas): void {
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
    if (
      !(mount instanceof HTMLDivElement) ||
      mount.getAttribute("role") !== VIRTUAL_ROWS_MOUNT_ROLE
    ) {
      throw new Error("A virtual row canvas lost its semantic table mount.");
    }
    canvas.remove();
    suspendedMountByCanvas.set(canvas, mount);
  }
}

function transferActivityCanvasRegistration(
  previousCanvas: VirtualRowsCanvas,
  nextCanvas: VirtualRowsCanvas,
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

function registerActivityCanvas(canvas: VirtualRowsCanvas): void {
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

function unregisterActivityCanvas(canvas: VirtualRowsCanvas): void {
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
  section: VirtualRowsCanvas,
  source: "canvas" | "template",
): Map<string, VirtualRowsRow> {
  const rows = new Map<string, VirtualRowsRow>();
  for (const child of section.children) {
    if (!(child instanceof HTMLDivElement) || child.getAttribute("role") !== VIRTUAL_ROW_ROLE) {
      throw new Error(`A virtual row ${source} contains an invalid semantic row.`);
    }
    const row = child;
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
