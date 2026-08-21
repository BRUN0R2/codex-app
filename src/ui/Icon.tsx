import type { JSX } from "solid-js";

export type IconName =
  | "anchor"
  | "archive"
  | "arrowLeft"
  | "arrowUp"
  | "barChart"
  | "book"
  | "bot"
  | "bolt"
  | "brain"
  | "briefcase"
  | "bug"
  | "calendar"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "close"
  | "cloud"
  | "cloudRain"
  | "cloudSun"
  | "codeBraces"
  | "computer"
  | "copy"
  | "cornerDownLeft"
  | "creditCard"
  | "cupcake"
  | "dollar"
  | "download"
  | "dumbbell"
  | "edit"
  | "egg"
  | "externalLink"
  | "file"
  | "flask"
  | "flower"
  | "folder"
  | "folderOpen"
  | "fountainPen"
  | "gitBranch"
  | "gitPullRequest"
  | "globe"
  | "globeStand"
  | "graduationCap"
  | "hammer"
  | "heart"
  | "helpCircle"
  | "image"
  | "kettlebell"
  | "keyboard"
  | "layers"
  | "link"
  | "logout"
  | "lotus"
  | "mic"
  | "monitor"
  | "more"
  | "music"
  | "newChat"
  | "notebook"
  | "palette"
  | "paperclip"
  | "panel"
  | "paw"
  | "pin"
  | "plane"
  | "plant"
  | "plus"
  | "puzzle"
  | "reset"
  | "scale"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "sidebar"
  | "sliders"
  | "sparkles"
  | "star"
  | "stethoscope"
  | "stop"
  | "syncCheck"
  | "telescope"
  | "terminal"
  | "trash"
  | "user"
  | "wand"
  | "worktree"
  | "wrench";

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
      stroke-width={props.strokeWidth ?? 2}
      viewBox="0 0 24 24"
      width={props.size ?? 18}
    >
      {renderIconPath(props.name)}
    </svg>
  );
}

function renderIconPath(name: IconName): JSX.Element {
  switch (name) {
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
    case "bolt":
      return (
        <path
          d="M13.2 1.8 4.4 13.1a.75.75 0 0 0 .6 1.2h6.1l-1 7.1a.75.75 0 0 0 1.3.6l8.2-11.2a.75.75 0 0 0-.6-1.2h-5.7l1.2-7.2a.75.75 0 0 0-1.3-.6Z"
          fill="currentColor"
          stroke="none"
        />
      );
    case "calendar":
      return (
        <>
          <rect height="16" rx="2" width="18" x="3" y="5" />
          <path d="M8 3v4M16 3v4M3 10h18" />
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
    case "cloud":
      return <path d="M6.5 17a4.5 4.5 0 1 1 .4-9 6 6 0 0 1 11.6 1.5A3.5 3.5 0 0 1 17.5 17H6.5Z" />;
    case "cloudRain":
      return (
        <>
          <path d="M6.5 15a4.5 4.5 0 1 1 .4-9 6 6 0 0 1 11.6 1.5A3.5 3.5 0 0 1 17.5 15H6.5Z" />
          <path d="M8 19v2M12 19v2M16 19v2" />
        </>
      );
    case "cloudSun":
      return (
        <>
          <path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M7 12a5 5 0 0 1 9.7 1.7A3.5 3.5 0 0 1 17.5 20H7.5a4 4 0 0 1-.5-8Z" />
          <circle cx="16.5" cy="6.5" r="1.8" />
        </>
      );
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
    case "cornerDownLeft":
      return (
        <>
          <path d="m9 10-5 5 5 5" />
          <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </>
      );
    case "creditCard":
      return (
        <>
          <rect height="14" rx="2.5" width="19" x="2.5" y="5" />
          <path d="M2.5 10h19M6.5 14.5h4" />
        </>
      );
    case "edit":
      return (
        <>
          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          <path d="m15 5 4 4" />
        </>
      );
    case "newChat":
      return (
        <g fill="currentColor" stroke="none" transform="scale(1.5)">
          <path d="M6.33325 1.88379C6.58178 1.88379 6.78345 2.08546 6.78345 2.33398C6.78328 2.58237 6.58168 2.78418 6.33325 2.78418H4.66626C3.62638 2.78435 2.78362 3.62711 2.78345 4.66699V11.334C2.78361 12.3739 3.62637 13.2176 4.66626 13.2178H11.3333C12.3733 13.2178 13.2169 12.374 13.217 11.334V9.66699C13.2172 9.41872 13.418 9.21795 13.6663 9.21777C13.9147 9.21777 14.1163 9.41861 14.1165 9.66699V11.334C14.1163 12.871 12.8703 14.1172 11.3333 14.1172H4.66626C3.12932 14.117 1.88322 12.8709 1.88306 11.334V4.66699C1.88323 3.13006 3.12933 1.88396 4.66626 1.88379H6.33325Z" />
          <path
            clip-rule="evenodd"
            d="M10.8948 2.375C11.6494 1.63227 12.8628 1.63698 13.6116 2.38574C14.362 3.13643 14.3637 4.35266 13.6165 5.10644L9.36353 9.39355C9.01402 9.74579 8.56977 9.98985 8.08521 10.0967L6.17603 10.5166C5.74813 10.6107 5.36686 10.2296 5.46118 9.80176L5.88208 7.89746C5.98978 7.4105 6.23578 6.96428 6.59106 6.61426L10.8948 2.375ZM12.9749 3.02148C12.5756 2.62258 11.9289 2.62086 11.5266 3.0166L7.2229 7.25586C6.99148 7.4839 6.83116 7.77457 6.76099 8.0918L6.44165 9.53711L7.89185 9.21777C8.20744 9.14811 8.49721 8.98919 8.72485 8.75976L12.9778 4.47266C13.3759 4.07066 13.375 3.42164 12.9749 3.02148Z"
            fill-rule="evenodd"
          />
        </g>
      );
    case "file":
      return (
        <>
          <path d="M6 2h8l4 4v16H6z" />
          <path d="M14 2v5h5" />
        </>
      );
    case "folder":
      return (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      );
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
    case "gitPullRequest":
      return (
        <>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="8" r="2.5" />
          <path d="M6 8.5v7M18 10.5v3a4 4 0 0 1-4 4h-3" />
        </>
      );
    case "globe":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </>
      );
    case "helpCircle":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
        </>
      );
    case "image":
      return (
        <>
          <rect height="18" rx="2" width="20" x="2" y="3" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
          <path d="m14 12-2-2-7 7" />
        </>
      );
    case "keyboard":
      return (
        <>
          <rect height="13" rx="2" width="19" x="2.5" y="6" />
          <path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M6 14h.01M9 14h3M15 14h3" />
        </>
      );
    case "layers":
      return (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      );
    case "link":
      return (
        <>
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </>
      );
    case "logout":
      return (
        <>
          <path d="M10 17l5-5-5-5M15 12H3" />
          <path d="M15 3h6v18h-6" />
        </>
      );
    case "mic":
      return (
        <>
          <rect height="10" rx="3" width="6" x="9" y="2" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
        </>
      );
    case "monitor":
      return (
        <>
          <rect height="14" rx="2" width="20" x="2" y="3" />
          <path d="M8 21h8M12 17v4" />
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
    case "puzzle":
      return (
        <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />
      );
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
    case "sparkles":
      return (
        <>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
          <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6Z" />
        </>
      );
    case "stop":
      return <rect height="12" rx="2" width="12" x="6" y="6" />;
    case "terminal":
      return (
        <>
          <path d="m7 11 2-2-2-2" />
          <path d="M11 13h4" />
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        </>
      );
    case "anchor":
      return (
        <>
          <circle cx="12" cy="5" r="3" />
          <path d="M12 22V8M5 12H2a10 10 0 0 0 20 0h-3" />
        </>
      );
    case "download":
      return (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </>
      );
    case "egg":
      return <path d="M12 22C6.5 22 4 16.5 4 12c0-5 3.5-10 8-10s8 5 8 10c0 4.5-2.5 10-8 10z" />;
    case "externalLink":
      return (
        <>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" x2="21" y1="14" y2="3" />
        </>
      );
    case "sliders":
      return (
        <>
          <line x1="4" x2="4" y1="21" y2="14" />
          <line x1="4" x2="4" y1="10" y2="3" />
          <line x1="12" x2="12" y1="21" y2="12" />
          <line x1="12" x2="12" y1="8" y2="3" />
          <line x1="20" x2="20" y1="21" y2="16" />
          <line x1="20" x2="20" y1="12" y2="3" />
          <line x1="1" x2="7" y1="14" y2="14" />
          <line x1="9" x2="15" y1="8" y2="8" />
          <line x1="17" x2="23" y1="16" y2="16" />
        </>
      );
    case "stethoscope":
      return (
        <>
          <path d="M11 2v2" />
          <path d="M5 2v2" />
          <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" />
          <path d="M8 15a6 6 0 0 0 12 0v-3" />
          <circle cx="20" cy="10" r="2" />
        </>
      );
    case "user":
      return (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 22a8 8 0 0 1 16 0" />
        </>
      );
    case "wand":
      return (
        <>
          <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
          <path d="m14 7 3 3" />
          <path d="M5 6v4" />
          <path d="M19 14v4" />
          <path d="M10 2v2" />
          <path d="M7 8H3" />
          <path d="M21 16h-4" />
          <path d="M11 3H9" />
        </>
      );
    case "book":
      return (
        <>
          <path d="M12 7v14" />
          <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
        </>
      );
    case "briefcase":
      return (
        <>
          <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          <rect width="20" height="14" x="2" y="6" rx="2" />
        </>
      );
    case "heart":
      return (
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      );
    case "music":
      return (
        <>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </>
      );
    case "palette":
      return (
        <>
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </>
      );
    case "paw":
      return (
        <>
          <circle cx="11" cy="4" r="2" />
          <circle cx="18" cy="8" r="2" />
          <circle cx="20" cy="16" r="2" />
          <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
        </>
      );
    case "star":
      return (
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      );
    case "worktree":
      return (
        <>
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </>
      );
    case "barChart":
      return (
        <>
          <line x1="18" x2="18" y1="20" y2="10" />
          <line x1="12" x2="12" y1="20" y2="4" />
          <line x1="6" x2="6" y1="20" y2="14" />
        </>
      );
    case "brain":
      return (
        <>
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
          <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
          <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
          <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
          <path d="M6 18a4 4 0 0 1-1.967-.516" />
          <path d="M19.967 17.484A4 4 0 0 1 18 18" />
        </>
      );
    case "codeBraces":
      return (
        <>
          <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
          <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
        </>
      );
    case "cupcake":
      return (
        <>
          <path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8" />
          <path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1" />
          <path d="M2 21h20" />
          <path d="M7 8v3" />
          <path d="M12 8v3" />
          <path d="M17 8v3" />
          <path d="M7 4h.01" />
          <path d="M12 4h.01" />
          <path d="M17 4h.01" />
        </>
      );
    case "dollar":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
          <path d="M12 18V6" />
        </>
      );
    case "dumbbell":
      return (
        <>
          <path d="M14.4 14.4 9.6 9.6" />
          <path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z" />
          <path d="m21.5 21.5-1.4-1.4" />
          <path d="M3.9 3.9 2.5 2.5" />
          <path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z" />
        </>
      );
    case "flask":
      return (
        <>
          <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" />
          <path d="M6.453 15h11.094" />
          <path d="M8.5 2h7" />
        </>
      );
    case "flower":
      return (
        <>
          <path d="M12 5a3 3 0 1 1 3 3m-3-3a3 3 0 1 0-3 3m3-3v1M9 8a3 3 0 1 0 3 3M9 8h1m5 0a3 3 0 1 1-3 3m3-3h-1m-2 3v-1" />
          <circle cx="12" cy="8" r="2" />
          <path d="M12 10v12" />
          <path d="M12 22c4.2 0 7-1.667 7-5-4.2 0-7 1.667-7 5Z" />
          <path d="M12 22c-4.2 0-7-1.667-7-5 4.2 0 7 1.667 7 5Z" />
        </>
      );
    case "fountainPen":
      return (
        <>
          <path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z" />
          <path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18" />
          <path d="m2.3 2.3 7.286 7.286" />
          <circle cx="11" cy="11" r="2" />
        </>
      );
    case "globeStand":
      return (
        <>
          <circle cx="13" cy="9" r="6" />
          <path d="M6 9a7.5 7.5 0 0 0 11.5 6.5" />
          <path d="M12 16v4M9 20h6" />
        </>
      );
    case "graduationCap":
      return (
        <>
          <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
          <path d="M22 10v6" />
          <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
        </>
      );
    case "kettlebell":
      return (
        <>
          <path d="M8 6a4 4 0 0 1 8 0v2H8V6z" />
          <circle cx="12" cy="15" r="7" />
        </>
      );
    case "lotus":
      return (
        <>
          <path d="M12 4c2.5 3 4 7 4 10H8c0-3 1.5-7 4-10z" />
          <path d="M12 14c4-1 7-5 8-9-3 3-6 7-8 9z" />
          <path d="M12 14c-4-1-7-5-8-9 3 3 6 7 8 9z" />
        </>
      );
    case "notebook":
      return (
        <>
          <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
          <path d="M2 6h4" />
          <path d="M2 10h4" />
          <path d="M2 14h4" />
          <path d="M2 18h4" />
          <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />
        </>
      );
    case "plane":
      return (
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.7 5.2c.3.4.8.5 1.3.3l.5-.3c.4-.2.6-.6.5-1.1z" />
      );
    case "plant":
      return (
        <>
          <path d="M7 20h10" />
          <path d="M10 20c5.5-2.5.8-6.4 3-10" />
          <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z" />
          <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z" />
        </>
      );
    case "scale":
      return (
        <>
          <path d="M16 9h3" />
          <path d="M2 18a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6" />
          <path d="M12 12V3" />
          <path d="M16 3h-8" />
          <path d="M16 6h-8" />
        </>
      );
    case "wrench":
      return (
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      );
    case "bug":
      return (
        <>
          <path d="m8 2 1.88 1.88" />
          <path d="M14.12 3.88 16 2" />
          <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
          <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
          <path d="M12 20v-9" />
          <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
          <path d="M6 13H2" />
          <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
          <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
          <path d="M22 13h-4" />
          <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
        </>
      );
    case "hammer":
      return (
        <>
          <path d="M8.4 8.4 20 20" />
          <path d="M15.6 8.4 4 20" />
          <path d="M11.1 10.2 5.3 4.4c1-1 2.6-1.6 4.4-1.5-2.1-1.1-4.7-.9-6.3.7L1.8 5.2l2 2 1.7-1.7 4.2 4.2" />
          <path d="m12.9 10.2 5.8-5.8c-1-1-2.6-1.6-4.4-1.5 2.1-1.1 4.7-.9 6.3.7l1.6 1.6-2 2-1.7-1.7-4.2 4.2" />
        </>
      );
    case "syncCheck":
      return (
        <>
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 16h5v5" />
          <path d="m9 12 2 2 4-4" />
        </>
      );
    case "trash":
      return (
        <>
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
          <path d="M10 11v5M14 11v5" />
        </>
      );
    case "telescope":
      return (
        <g stroke-width="1.55">
          <path d="m4.2 10.1 14.7-5.3 1.5 4.2-14.7 5.3Z" />
          <path d="m2.1 10.9 2.3-.8 1.6 4.6-2.3.8Z" />
          <path d="m9.3 8.3 1.6 4.4" />
          <ellipse cx="20.4" cy="6.9" rx="1.55" ry="2.8" transform="rotate(-20 20.4 6.9)" />
          <circle cx="12.5" cy="13.5" r="1.1" />
          <path d="M12.5 14.6v1.5" />
          <path d="M10.4 16.1h4.2" />
          <path d="m11.3 16.1-4.5 6.4" />
          <path d="m13.7 16.1 4.5 6.4" />
        </g>
      );
  }
}
