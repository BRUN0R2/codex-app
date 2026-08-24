export function touchMostRecentEntry<K, V>(entries: Map<K, V>, key: K, capacity: number): void {
  const entry = entries.get(key);
  if (entry === undefined) {
    return;
  }
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > capacity) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) {
      throw new Error("Recently-used entry cache lost its eviction candidate.");
    }
    entries.delete(oldestKey);
  }
}
