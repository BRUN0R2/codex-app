const TAB_COLUMNS = 4;

export function monospaceColumnCount(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns = character === "\t" ? columns + (TAB_COLUMNS - (columns % TAB_COLUMNS)) : columns + 1;
  }
  return columns;
}
