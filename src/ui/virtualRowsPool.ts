const MAXIMUM_AVAILABLE_ROW_SECTIONS = 2;

export interface VirtualRowsLease {
  readonly element: HTMLTableSectionElement;
  readonly release: () => void;
}

export class VirtualRowsPool {
  readonly #available: HTMLTableSectionElement[] = [];
  readonly #template: HTMLTableSectionElement;

  constructor(template: HTMLTableSectionElement) {
    this.#template = template;
  }

  acquire(): VirtualRowsLease {
    const element =
      this.#available.pop() ?? (this.#template.cloneNode(true) as HTMLTableSectionElement);
    let active = true;
    return {
      element,
      release: () => {
        if (!active) {
          return;
        }
        active = false;
        element.remove();
        if (this.#available.length < MAXIMUM_AVAILABLE_ROW_SECTIONS) {
          this.#available.push(element);
        }
      },
    };
  }
}
