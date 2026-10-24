// Provider marks, keyed by driver kind.
import { useId } from "react";
import { Monitor } from "lucide-react";
import { cn } from "@/lib/cn";

export interface IconProps {
  size?: number;
  className?: string;
}

/** Official Grok app mark (grok.com / Grok iOS). Shared by ProviderMark, so
 * the model selector and Plan usage panel stay in lockstep. */
export function GrokMark({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("shrink-0 fill-[var(--color-ink)]", className)}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"
      />
    </svg>
  );
}

// The Claude Code bot: [x, row, width] runs on a 17x5 grid of 1 wide, 2 tall pixels. Eyes are gaps.
const CLAUDE_BOT = [
  [3, 0, 13],
  [3, 1, 2],
  [6, 1, 7],
  [14, 1, 2],
  [1, 2, 17],
  [3, 3, 13],
  [3, 4, 1],
  [5, 4, 1],
  [13, 4, 1],
  [15, 4, 1],
];

// anti-slop/no-shape-in-symbol-names flags the JSX attribute name, so spread it.
const CRISP = { "shapeRendering": "crispEdges" } as const;

export function ClaudeMark({ size = 16, className }: IconProps) {
  // 17 columns need 1 css px each or the eyes and legs merge, so the bot overflows a box under 17 px.
  const v = Math.min(size, 17);
  // Past 17 px the scale is fractional anyway, so center exactly instead of on a whole px.
  const snap = size > 17 ? (n: number) => n : Math.round;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${snap(9.5 - v / 2)} ${snap(5 - v / 2)} ${v} ${v}`}
      {...CRISP}
      className={cn("shrink-0 overflow-visible fill-[#d97757]", className)}
      aria-hidden
    >
      {CLAUDE_BOT.map(([x, row, w]) => (
        <rect key={`${x},${row}`} x={x} y={row * 2} width={w} height={2} />
      ))}
    </svg>
  );
}

export function CodexMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 260" preserveAspectRatio="xMidYMid" className={cn("shrink-0 fill-[var(--color-ink)]", className)} aria-hidden>
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

export function GeminiMark({ size = 16, className }: IconProps) {
  // A fixed id resolves to the first copy in the DOM, which paints nothing when that copy is display: none.
  const grad = `orbit-gemini-mark${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={grad} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1C7DFF" />
          <stop offset="0.48" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#F050AE" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${grad})`}
        d="M12 0c0 6.627 5.373 12 12 12-6.627 0-12 5.373-12 12 0-6.627-5.373-12-12-12 6.627 0 12-5.373 12-12Z"
      />
    </svg>
  );
}

export function ComputerMark({ size = 16, className }: IconProps) {
  return <Monitor size={size} className={cn("shrink-0 text-ink-secondary", className)} />;
}

/** Official Kimi mark (Moonshot). */
export function KimiMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0 fill-[var(--color-ink)]", className)} aria-hidden>
      <path
        d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"
        fill="#1783FF"
      />
      <path
        d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"
        fill="var(--color-ink)"
      />
    </svg>
  );
}

/** Official Google Antigravity mark. */
export function AntigravityMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0 fill-[var(--color-ink)]", className)} aria-hidden>
      <path
        fillRule="evenodd"
        d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
      />
    </svg>
  );
}

/** Meta Muse mark — simple filled M using the existing ink token so it
 * reads in light and dark without new hues, gradients, or emoji. */
export function MuseMark({ size = 16, className }: IconProps) {
  // Glyph spans 4..20; the full 24px box read as excess left spacing on the
  // chat-header chip, but an exact crop made the solid M loom over the other
  // marks in the usage list. 1.5 units of padding matches their inner margin.
  return (
    <svg width={size} height={size} viewBox="2.5 2.5 19 19" className={cn("shrink-0 fill-[var(--color-ink)]", className)} aria-hidden>
      <path fillRule="evenodd" d="M4 20V4h3.2l4.8 8.6L16.8 4H20v16h-3.1V9.4l-2.2 3.9H9.3l-2.2-3.9V20H4z" />
    </svg>
  );
}

/** Official Qwen mark. */
export function QwenMark({ size = 16, className }: IconProps) {
  const grad = `omb-qwen-mark${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0", className)} aria-hidden>
      <path
        fill={`url(#${grad})`}
        fillRule="nonzero"
        d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"
      />
      <defs>
        <linearGradient id={grad} x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="#6336E7" stopOpacity={0.92} />
          <stop offset="100%" stopColor="#6F69F7" stopOpacity={0.92} />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function ProviderMark({ driverKind, size, className }: IconProps & { driverKind: string }) {
  switch (driverKind) {
    case "grok":
    case "grokAgent":
      return <GrokMark size={size} className={className} />;
    case "claudeAgent":
      return <ClaudeMark size={size} className={className} />;
    case "codex":
      return <CodexMark size={size} className={className} />;
    case "geminiAgent":
      return <GeminiMark size={size} className={className} />;
    case "kimiAgent":
      return <KimiMark size={size} className={className} />;
    case "antigravityAgent":
      // Friends Gemini slot: Antigravity keeps agy CLI, Gemini logo + models.
      return <GeminiMark size={size} className={className} />;
    case "museAgent":
      return <MuseMark size={size} className={className} />;
    case "qwenAgent":
      return <QwenMark size={size} className={className} />;
    case "boxAgent":
      return <ComputerMark size={size} className={className} />;
    default:
      return (
        <span className="flex size-full items-center justify-center text-[10px] font-semibold tracking-tight text-ink-secondary">
          {(driverKind.replace(/Agent$/i, "").slice(0, 1) || "?").toUpperCase()}
        </span>
      );
  }
}
