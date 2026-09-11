import { createContext, type ParentProps, useContext } from "solid-js";

import type { AppController } from "../state/appController";

export type ContentResourceReader = Pick<AppController, "readAttachmentImage" | "readThreadOutput">;

const ContentResourceReaderContext = createContext<ContentResourceReader>();

export function ContentResourceReaderProvider(
  props: ParentProps<{ readonly reader: ContentResourceReader }>,
) {
  return (
    <ContentResourceReaderContext.Provider value={props.reader}>
      {props.children}
    </ContentResourceReaderContext.Provider>
  );
}

export function useContentResourceReader(): ContentResourceReader {
  const reader = useContext(ContentResourceReaderContext);
  if (reader === undefined) {
    throw new Error("Content resources require a ContentResourceReaderProvider.");
  }
  return reader;
}
