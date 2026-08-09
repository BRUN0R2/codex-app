import { readAttachmentImage } from "../infrastructure/codexClient";

const DIRECT_IMAGE_DATA = /^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp)(?:[;,])/iu;
const IMAGE_PATH = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu;
const imageSourceCache = new Map<string, Promise<string>>();

export function isDirectImageSource(source: string): boolean {
  const value = source.trim();
  if (DIRECT_IMAGE_DATA.test(value) || value.startsWith("blob:")) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function resolveImageSource(source: string): Promise<string> {
  const value = source.trim();
  if (isDirectImageSource(value)) {
    return Promise.resolve(value);
  }
  if (value.length === 0) {
    return Promise.reject(new Error("A imagem não possui uma origem válida."));
  }

  const cached = imageSourceCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const pending = readAttachmentImage(value)
    .then((response) => response.dataUrl)
    .catch((reason: unknown) => {
      imageSourceCache.delete(value);
      throw reason;
    });
  imageSourceCache.set(value, pending);
  return pending;
}

export function extractToolImageSource(name: unknown, output: unknown): string | null {
  if (
    typeof name !== "string" ||
    typeof output !== "string" ||
    !name.toLowerCase().includes("image")
  ) {
    return null;
  }
  const value = output.trim();
  if (isImageSourceCandidate(value)) {
    return value;
  }
  try {
    return findImageSource(JSON.parse(value) as unknown, 0);
  } catch {
    return null;
  }
}

function findImageSource(value: unknown, depth: number): string | null {
  if (depth > 5) {
    return null;
  }
  if (typeof value === "string") {
    return isImageSourceCandidate(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const source = findImageSource(entry, depth + 1);
      if (source !== null) {
        return source;
      }
    }
    return null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }

  const object = value as Record<string, unknown>;
  for (const key of ["image_url", "imageUrl", "path", "source", "src", "url"]) {
    const source = findImageSource(object[key], depth + 1);
    if (source !== null) {
      return source;
    }
  }
  for (const entry of Object.values(object)) {
    const source = findImageSource(entry, depth + 1);
    if (source !== null) {
      return source;
    }
  }
  return null;
}

function isImageSourceCandidate(value: string): boolean {
  const source = value.trim();
  return isDirectImageSource(source) || (source.length <= 4_096 && IMAGE_PATH.test(source));
}
