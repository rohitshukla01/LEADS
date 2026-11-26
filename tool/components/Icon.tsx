// Small line-icon set (visual only) in one consistent 1.6-stroke style. Inline SVG, so no
// icon package is needed.
type Name =
  | "menu" | "logout" | "plus" | "edit" | "close" | "alert" | "check" | "x"
  | "arrowUp" | "info" | "chevronDown" | "chevronUp" | "user" | "chat" | "pipeline" | "download" | "members";

const PATHS: Record<Name, React.ReactNode> = {
  menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  edit: <><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M14.5 7.5l3 3" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  alert: <><path d="M12 4l9 16H3L12 4z" /><path d="M12 10v4" /><path d="M12 17.2v.1" /></>,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  x: <><path d="M7 7l10 10" /><path d="M17 7L7 17" /></>,
  arrowUp: <><path d="M12 19V6" /><path d="M6.5 11.5L12 6l5.5 5.5" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><path d="M12 8v.1" /></>,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronUp: <path d="M6 14.5l6-6 6 6" />,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  chat: <path d="M5 5h14v10H9l-4 4V5z" />,
  pipeline: <><path d="M5 7h14" /><path d="M5 12h10" /><path d="M5 17h6" /></>,
  download: <><path d="M12 4v11" /><path d="M7 10.5l5 5 5-5" /><path d="M5 20h14" /></>,
  members: <><path d="M3 12h4" /><path d="M7 12c5 0 7-6 14-7" /><path d="M7 12c5 0 7-2.5 14-3" /><path d="M7 12c5 0 7 2.5 14 3" /><path d="M7 12c5 0 7 6 14 7" /></>,
};

export default function Icon({ name, size = 16, stroke = 1.6, color = "currentColor", style, title }: {
  name: Name; size?: number; stroke?: number; color?: string; style?: React.CSSProperties; title?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}
      style={{ display: "inline-block", flexShrink: 0, verticalAlign: "middle", ...style }}>
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
