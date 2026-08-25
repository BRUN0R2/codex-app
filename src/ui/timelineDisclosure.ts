import { createSignal } from "solid-js";

import { timelineIdentityPrefixes } from "./timelineIdentity";

declare const timelineDisclosureKeyBrand: unique symbol;

export type TimelineDisclosureKey = string & {
  readonly [timelineDisclosureKeyBrand]: true;
};

export interface TimelineDisclosureStore {
  readonly countOpenDescendants: (key: TimelineDisclosureKey) => number;
  readonly read: (key: TimelineDisclosureKey, fallback?: boolean) => boolean;
  readonly setOpen: (key: TimelineDisclosureKey, open: boolean) => void;
  readonly subtreeRevision: (key: TimelineDisclosureKey) => number;
}

interface DisclosureNode {
  children: Map<string, DisclosureNode>;
  childrenGeneration: number;
  explicitOpen: boolean | undefined;
  openSubtreeCount: number;
  readonly parent: DisclosureNode | null;
  readonly parentGeneration: number;
  subtreeRevision: number;
}

const DISCLOSURE_NODE_CACHE_CAPACITY = 512;

export function createTimelineDisclosureStore(): TimelineDisclosureStore {
  const root = createDisclosureNode(null);
  const nodeCache = new Map<string, DisclosureNode>();
  const [revision, setRevision] = createSignal(0);

  return {
    countOpenDescendants(key) {
      revision();
      const node = findDisclosureNode(root, nodeCache, key);
      return node === null ? 0 : node.openSubtreeCount - (node.explicitOpen === true ? 1 : 0);
    },
    read(key, fallback = false) {
      revision();
      return findDisclosureNode(root, nodeCache, key)?.explicitOpen ?? fallback;
    },
    setOpen(key, open) {
      if (setDisclosureOpen(root, key, open)) {
        setRevision((current) => current + 1);
      }
    },
    subtreeRevision(key) {
      revision();
      return findDisclosureNode(root, nodeCache, key)?.subtreeRevision ?? 0;
    },
  };
}

function createDisclosureNode(parent: DisclosureNode | null): DisclosureNode {
  return {
    children: new Map(),
    childrenGeneration: 0,
    explicitOpen: undefined,
    openSubtreeCount: 0,
    parent,
    parentGeneration: parent?.childrenGeneration ?? 0,
    subtreeRevision: 0,
  };
}

function findDisclosureNode(
  root: DisclosureNode,
  nodeCache: Map<string, DisclosureNode>,
  key: TimelineDisclosureKey,
): DisclosureNode | null {
  const cached = nodeCache.get(key);
  if (cached !== undefined) {
    if (isDisclosureNodeActive(root, cached)) {
      return cached;
    }
    nodeCache.delete(key);
  }
  let node = root;
  for (const prefix of timelineIdentityPrefixes(key)) {
    const child = node.children.get(prefix);
    if (child === undefined) {
      return null;
    }
    node = child;
  }
  cacheDisclosureNode(nodeCache, key, node);
  return node;
}

function resolveDisclosurePath(
  root: DisclosureNode,
  key: TimelineDisclosureKey,
): readonly DisclosureNode[] {
  const path: DisclosureNode[] = [root];
  let node = root;
  for (const prefix of timelineIdentityPrefixes(key)) {
    let child = node.children.get(prefix);
    if (child === undefined) {
      child = createDisclosureNode(node);
      node.children.set(prefix, child);
    }
    path.push(child);
    node = child;
  }
  return path;
}

function setDisclosureOpen(
  root: DisclosureNode,
  key: TimelineDisclosureKey,
  open: boolean,
): boolean {
  const path = resolveDisclosurePath(root, key);
  const node = path.at(-1);
  if (node === undefined) {
    throw new Error("Timeline disclosure paths must contain their target node.");
  }
  if (open) {
    if (node.explicitOpen === true) {
      return false;
    }
    node.explicitOpen = true;
    adjustOpenSubtreeCounts(path, 1);
    return true;
  }

  const currentOpenCount = node.explicitOpen === true ? 1 : 0;
  const openDescendantCount = node.openSubtreeCount - currentOpenCount;
  if (node.children.size === 0) {
    if (node.explicitOpen === false) {
      return false;
    }
    node.explicitOpen = false;
    if (currentOpenCount === 1) {
      adjustOpenSubtreeCounts(path, -1);
    }
    return true;
  }

  const removedOpenCount = node.openSubtreeCount;
  node.children = new Map();
  node.childrenGeneration += 1;
  node.explicitOpen = false;
  node.openSubtreeCount = 0;
  if (removedOpenCount > 0) {
    adjustOpenSubtreeCounts(path.slice(0, -1), -removedOpenCount);
  }
  if (openDescendantCount > 0) {
    node.subtreeRevision += 1;
  }
  return true;
}

function cacheDisclosureNode(
  nodeCache: Map<string, DisclosureNode>,
  key: TimelineDisclosureKey,
  node: DisclosureNode,
): void {
  if (!nodeCache.has(key) && nodeCache.size >= DISCLOSURE_NODE_CACHE_CAPACITY) {
    const oldestKey = nodeCache.keys().next().value;
    if (typeof oldestKey === "string") {
      nodeCache.delete(oldestKey);
    }
  }
  nodeCache.set(key, node);
}

function isDisclosureNodeActive(root: DisclosureNode, node: DisclosureNode): boolean {
  let current = node;
  while (current.parent !== null) {
    if (current.parentGeneration !== current.parent.childrenGeneration) {
      return false;
    }
    current = current.parent;
  }
  return current === root;
}

function adjustOpenSubtreeCounts(path: readonly DisclosureNode[], delta: number): void {
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new Error("Timeline disclosure count changes must be non-zero safe integers.");
  }
  for (const node of path) {
    const next = node.openSubtreeCount + delta;
    if (next < 0) {
      throw new Error("Timeline disclosure descendant counts became negative.");
    }
    node.openSubtreeCount = next;
  }
}
