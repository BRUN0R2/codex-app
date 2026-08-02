import type { JSX } from "solid-js";

export type IconName =
  | "archive"
  | "arrowLeft"
  | "arrowUp"
  | "bot"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "close"
  | "computer"
  | "copy"
  | "edit"
  | "file"
  | "folder"
  | "folderOpen"
  | "gitBranch"
  | "layers"
  | "logout"
  | "more"
  | "paperclip"
  | "panel"
  | "pin"
  | "plus"
  | "reset"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "sidebar"
  | "stop"
  | "terminal"
  | "user";

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly strokeWidth?: number;
}

export function Icon(props: IconProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={props.size ?? 18}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={props.strokeWidth ?? 1.8}
      viewBox="0 0 24 24"
      width={props.size ?? 18}
    >
      <IconPath name={props.name} />
    </svg>
  );
}

function IconPath(props: { readonly name: IconName }): JSX.Element {
  switch (props.name) {
    case "archive":
      return (
        <>
          <path d="M4 7h16v13H4z" />
          <path d="M3 3h18v4H3zM9 11h6" />
        </>
      );
    case "arrowLeft":
      return <path d="m15 18-6-6 6-6M9 12h10" />;
    case "arrowUp":
      return <path d="m6 11 6-6 6 6M12 5v14" />;
    case "bot":
      return (
        <>
          <rect height="12" rx="3" width="16" x="4" y="8" />
          <path d="M12 4v4M8 13h.01M16 13h.01M9 17h6" />
        </>
      );
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevronDown":
      return <path d="m7 10 5 5 5-5" />;
    case "chevronRight":
      return <path d="m9 18 6-6-6-6" />;
    case "close":
      return <path d="m6 6 12 12M18 6 6 18" />;
    case "computer":
      return (
        <>
          <rect height="13" rx="2" width="18" x="3" y="4" />
          <path d="M8 21h8M12 17v4" />
        </>
      );
    case "copy":
      return (
        <>
          <rect height="13" rx="2" width="13" x="8" y="8" />
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </>
      );
    case "edit":
      return (
        <>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
        </>
      );
    case "file":
      return (
        <>
          <path d="M6 2h8l4 4v16H6z" />
          <path d="M14 2v5h5" />
        </>
      );
    case "folder":
      return <path d="M3 6h7l2 2h9v11H3z" />;
    case "folderOpen":
      return (
        <>
          <path d="M3 7V5h7l2 2h8a1 1 0 0 1 1 1v2" />
          <path d="M3 10h19l-3 9H4z" />
        </>
      );
    case "gitBranch":
      return (
        <>
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="6" cy="19" r="2" />
          <path d="M6 7v10M8 11h4a6 6 0 0 0 6-6" />
        </>
      );
    case "layers":
      return (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      );
    case "logout":
      return (
        <>
          <path d="M10 17l5-5-5-5M15 12H3" />
          <path d="M15 3h6v18h-6" />
        </>
      );
    case "more":
      return (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
          <circle cx="19" cy="12" r="1" fill="currentColor" />
        </>
      );
    case "paperclip":
      return <path d="m21 11-9 9a6 6 0 0 1-8-8l10-10a4 4 0 0 1 6 6L10 18a2 2 0 0 1-3-3l9-9" />;
    case "panel":
      return (
        <>
          <rect height="18" rx="2" width="20" x="2" y="3" />
          <path d="M15 3v18" />
        </>
      );
    case "pin":
      return (
        <>
          <path d="M6 3h12l-2 8 3 3v2H5v-2l3-3-2-8Z" />
          <path d="M12 16v6" />
        </>
      );
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "reset":
      return (
        <>
          <path d="M4 4v6h6" />
          <path d="M5.5 15a8 8 0 1 0 .5-7l-2 2" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </>
      );
    case "send":
      return (
        <>
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
        </>
      );
    case "settings":
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19 13.5v-3l-2-.8-.7-1.7.8-2-2.1-2.1-2 .8-1.7-.7-.8-2h-3l-.8 2-1.7.7-2-.8L.9 6l.8 2L1 9.7l-2 .8v3l2 .8.7 1.7-.8 2L3 20.1l2-.8 1.7.7.8 2h3l.8-2 1.7-.7 2 .8 2.1-2.1-.8-2 .7-1.7Z"
            transform="translate(2) scale(.83)"
          />
        </>
      );
    case "shield":
      return <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />;
    case "sidebar":
      return (
        <>
          <rect height="18" rx="2" width="20" x="2" y="3" />
          <path d="M8 3v18" />
        </>
      );
    case "stop":
      return <rect height="12" rx="2" width="12" x="6" y="6" />;
    case "terminal":
      return (
        <>
          <path d="m4 7 5 5-5 5M12 17h8" />
          <rect height="18" rx="2" width="20" x="2" y="3" />
        </>
      );
    case "user":
      return (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 22a8 8 0 0 1 16 0" />
        </>
      );
  }
}
