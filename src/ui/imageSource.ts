import { readAttachmentImage } from "../infrastructure/codexClient";

export const SAFE_IMAGE_DATA_MIME_PATTERN: string =
  "^data:image\\/(?:avif|gif|jpeg|png|webp)";

const DIRECT_IMAGE_DATA = new RegExp(`${SAFE_IMAGE_DATA_MIME_PATTERN}(?:[;,])`, "iu");

export function isDirectImageSource(source: string): boolean {
  const value = source.trim();
  if (DIRECT_IMAGE_DATA.test(value) || value.startsWith("blob:")) {
    return true;
  }
  return false;
}

export function resolveImageSource(source: string): Promise<string> {
  const value = source.trim();
  if (isDirectImageSource(value)) {
    return Promise.resolve(value);
  }
  if (value.length === 0) {
    return Promise.reject(new Error("The image has no valid source."));
  }
  if (isRemoteImageSource(value)) {
    return Promise.reject(new Error("Remote Markdown images are not loaded automatically."));
  }

  return readAttachmentImage(value).then((response) => response.dataUrl);
}

function isRemoteImageSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
