export interface MarkdownWorkerRequest {
  readonly id: number;
  readonly source: string;
}

export type MarkdownWorkerResponse =
  | { readonly id: number; readonly html: string; readonly ok: true }
  | { readonly id: number; readonly error: string; readonly ok: false };
