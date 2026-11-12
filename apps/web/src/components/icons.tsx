import type { CSSProperties, ReactNode } from 'react';

function Icon({ children, className = 'h-4 w-4', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

type P = { className?: string; style?: CSSProperties };
export const LinkIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Icon>
);
export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
export const PanelIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M14.5 4.5v15" />
  </Icon>
);
export const GearIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);
export const ExitIcon = (p: P) => (
  <Icon {...p}>
    <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
    <path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H15" />
  </Icon>
);
export const SendIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h13M12.5 6.5 18 12l-5.5 5.5" />
  </Icon>
);
export const LockIcon = (p: P) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="9" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Icon>
);
export const ExpandIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 9.5v-5h5M19.5 14.5v5h-5M14.5 4.5h5v5M9.5 19.5h-5v-5" />
  </Icon>
);
export const PointerIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 3.5 19 10l-6 2-2 6.5Z" />
  </Icon>
);
export const PlayIcon = (p: P) => (
  <Icon {...p}>
    <path d="M7.5 5v14l11-7Z" fill="currentColor" />
  </Icon>
);
export const PauseIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 5.5v13M16 5.5v13" strokeWidth="3" />
  </Icon>
);
export const VolumeIcon = ({ off, ...p }: P & { off?: boolean }) => (
  <Icon {...p}>
    <path d="M4.5 9.5v5h3l4.5 4v-13l-4.5 4Z" />
    {off ? <path d="m16 9.5 5 5M21 9.5l-5 5" /> : <path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />}
  </Icon>
);
export const MicIcon = ({ off, ...p }: P & { off?: boolean }) => (
  <Icon {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    {off && <path d="M4 4l16 16" />}
  </Icon>
);
export const CameraIcon = ({ off, ...p }: P & { off?: boolean }) => (
  <Icon {...p}>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2" />
    <path d="m15.5 10.5 5.5-3v9l-5.5-3" />
    {off && <path d="M4 4l16 16" />}
  </Icon>
);
export const PhoneIcon = (p: P) => (
  <Icon {...p}>
    <path d="M6.5 3.500h3l1.5 4-2 1.500a11 11 0 0 0 6 6l1.5-2 4 1.500v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.500a2 2 0 0 1 2-2Z" />
  </Icon>
);
