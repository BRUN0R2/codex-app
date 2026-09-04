import { createContext, type ParentProps, useContext } from "solid-js";

export type ExternalNavigation = (url: string) => Promise<boolean>;

const ExternalNavigationContext = createContext<ExternalNavigation>();

export function ExternalNavigationProvider(
  props: ParentProps<{ readonly open: ExternalNavigation }>,
) {
  return (
    <ExternalNavigationContext.Provider value={props.open}>
      {props.children}
    </ExternalNavigationContext.Provider>
  );
}

export function useExternalNavigation(): ExternalNavigation {
  const open = useContext(ExternalNavigationContext);
  if (open === undefined) {
    throw new Error("External navigation requires an ExternalNavigationProvider.");
  }
  return open;
}
