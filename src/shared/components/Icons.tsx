import type { JSX } from "solid-js";

interface IconProps {
  size?: number;
}

function Svg(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      width={props.size ?? 18}
    >
      {props.children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z" stroke="currentColor" stroke-width="1.7" />
      <path d="m19 13.1 1.2 1-.9 2.1-1.6-.1a7.3 7.3 0 0 1-1.6 1.6l.1 1.6-2.1.9-1-1.2a7.9 7.9 0 0 1-2.2 0l-1 1.2-2.1-.9.1-1.6a7.3 7.3 0 0 1-1.6-1.6l-1.6.1-.9-2.1 1.2-1a7.9 7.9 0 0 1 0-2.2l-1.2-1 .9-2.1 1.6.1a7.3 7.3 0 0 1 1.6-1.6l-.1-1.6 2.1-.9 1 1.2a7.9 7.9 0 0 1 2.2 0l1-1.2 2.1.9-.1 1.6a7.3 7.3 0 0 1 1.6 1.6l1.6-.1.9 2.1-1.2 1a7.9 7.9 0 0 1 0 2.2Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.4" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5v9.75c0 .97.78 1.75 1.75 1.75h13.5c.97 0 1.75-.78 1.75-1.75v-8.5c0-.97-.78-1.75-1.75-1.75h-6.1l-1.8-2H5.25C4.28 5 3.5 5.78 3.5 6.75v.75Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6" />
    </Svg>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.2 17.8 7.65-7.65a3 3 0 0 0-4.24-4.24L5.3 13.2a4.5 4.5 0 1 0 6.36 6.36l7.12-7.12" stroke="currentColor" stroke-linecap="round" stroke-width="1.7" />
    </Svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12 14-7-4.5 14-2.6-5.1L5 12Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.7" />
      <path d="m11.9 13.9 3.25-3.25" stroke="currentColor" stroke-linecap="round" stroke-width="1.7" />
    </Svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect fill="currentColor" height="9" rx="1.5" width="9" x="7.5" y="7.5" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5h7l5 5v12H6v-17Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" />
      <path d="M13 3.5v5h5" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" />
    </Svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="16" rx="2" stroke="currentColor" stroke-width="1.5" width="18" x="3" y="4" />
      <path d="m5.5 17 4.2-4.5 3.1 3 2.1-2 3.6 3.5" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" />
      <circle cx="15.5" cy="8.5" fill="currentColor" r="1.25" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 7.5V4l-1.5 1.5A8 8 0 1 0 20 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="5.5" stroke="currentColor" stroke-width="1.6" />
      <path d="m15 15 4 4" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m8 10 4 4 4-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m10 8 4 4-4 4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m14 8-4 4 4 4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6.5 12.5 3.4 3.4 7.6-8" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
    </Svg>
  );
}

export function SidebarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="15" rx="2" stroke="currentColor" stroke-width="1.5" width="18" x="3" y="4.5" />
      <path d="M8.5 5v14" stroke="currentColor" stroke-width="1.5" />
    </Svg>
  );
}

export function PanelRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="15" rx="2" stroke="currentColor" stroke-width="1.5" width="18" x="3" y="4.5" />
      <path d="M15.5 5v14" stroke="currentColor" stroke-width="1.5" />
    </Svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="12" fill="currentColor" r="1.25" />
      <circle cx="12" cy="12" fill="currentColor" r="1.25" />
      <circle cx="18" cy="12" fill="currentColor" r="1.25" />
    </Svg>
  );
}

export function SquarePenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M12 4H5.5A2.5 2.5 0 0 0 3 6.5v12A2.5 2.5 0 0 0 5.5 21h12a2.5 2.5 0 0 0 2.5-2.5V12"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.5"
      />
      <path
        d="m16.4 3.6 4 4L10 18l-4.5 1 1-4.5 9.9-9.9Z"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.5"
      />
    </Svg>
  );
}

export function LaptopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="11" rx="1.5" stroke="currentColor" stroke-width="1.5" width="16" x="4" y="4.5" />
      <path d="M2.5 18.5h19" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" />
    </Svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="5" r="2" stroke="currentColor" stroke-width="1.5" />
      <circle cx="17" cy="8" r="2" stroke="currentColor" stroke-width="1.5" />
      <circle cx="7" cy="19" r="2" stroke="currentColor" stroke-width="1.5" />
      <path d="M7 7v10M9 9.5h3a5 5 0 0 0 5-5" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" />
    </Svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" />
      <circle cx="16" cy="7" r="2" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="17" r="2" stroke="currentColor" stroke-width="1.5" />
    </Svg>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5c.6 4.1 2.4 5.9 6.5 6.5-4.1.6-5.9 2.4-6.5 6.5-.6-4.1-2.4-5.9-6.5-6.5 4.1-.6 5.9-2.4 6.5-6.5Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.45" />
      <path d="M18.5 15.5c.2 1.4.8 2 2 2.3-1.2.2-1.8.9-2 2.2-.2-1.3-.8-2-2-2.2 1.2-.3 1.8-.9 2-2.3Z" fill="currentColor" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 19 6v5.4c0 4.2-2.6 7.4-7 9.1-4.4-1.7-7-4.9-7-9.1V6l7-2.5Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" />
      <path d="m9 12 2 2 4-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" />
    </Svg>
  );
}

export function ShieldAlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 19 6v5.4c0 4.2-2.6 7.4-7 9.1-4.4-1.7-7-4.9-7-9.1V6l7-2.5Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" />
      <path d="M12 8.2v4.5" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" />
      <circle cx="12" cy="16" fill="currentColor" r="1" />
    </Svg>
  );
}
