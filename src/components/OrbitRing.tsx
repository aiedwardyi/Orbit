// Thin light around a working avatar. Two transform spins share one gradient:
// a blurred halo behind a sharp edge. The gradient itself never changes.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { botAvatarChoiceSchema, isBotAvatarId, resolveMascotStyle, type BotAvatarCrop, type MascotStyle } from "../../shared/bot-avatar";

const GAP = 2;

type ArtBox = { x: number; y: number; w: number; h: number; r: number; ellipse?: boolean };

// Painted bounds in the 256 viewBox, plus the corner radius of that shape.
const MASCOT_BOX = {
  squircle: { x: 40, y: 40, w: 176, h: 176, r: 56 },
  circle: { x: 42, y: 42, w: 172, h: 172, r: 86 },
  pill: { x: 24, y: 78, w: 208, h: 100, r: 50 },
  peach: { x: 26, y: 56, w: 204, h: 172, r: 86, ellipse: true },
  coral: { x: 38, y: 58, w: 180, h: 160, r: 80, ellipse: true },
  lavender: { x: 34, y: 40, w: 188, h: 186, r: 90, ellipse: true },
  teal: { x: 46, y: 28, w: 164, h: 208, r: 80, ellipse: true },
} satisfies Record<MascotStyle, ArtBox>;

// Shared plate on the packed icon PNGs (opaque rounded square, ~6px inset).
const ICON_BOX: ArtBox = { x: 6, y: 6, w: 244, h: 244, r: 42 };

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

function boxStyle(size: number, box: ArtBox): CSSProperties {
  const scale = size / 256;
  return {
    top: px(box.y * scale - GAP),
    right: px((256 - box.x - box.w) * scale - GAP),
    bottom: px((256 - box.y - box.h) * scale - GAP),
    left: px(box.x * scale - GAP),
    borderRadius: box.ellipse ? "50%" : px(box.r * scale + GAP),
  };
}

/** Ring box for one working-row avatar. Photo crops fill the element; mascots and icons do not. */
export function workingRingStyle(input: {
  size: number;
  crop: BotAvatarCrop;
  mascotStyle?: string | null;
  image: boolean;
}): CSSProperties {
  const { size } = input;
  if (input.image) {
    const radius = input.crop === "circle" ? size / 2 : input.crop === "rounded" ? size * 0.22 : 0;
    return { inset: -GAP, borderRadius: radius + GAP };
  }
  const choice = botAvatarChoiceSchema.safeParse(input.mascotStyle);
  if (choice.success && isBotAvatarId(choice.data)) return boxStyle(size, ICON_BOX);
  return boxStyle(size, MASCOT_BOX[resolveMascotStyle(input.mascotStyle, null)]);
}

function reducedNow(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const apply = () => setReduced(media.matches);
    media.addEventListener?.("change", apply);
    return () => media.removeEventListener?.("change", apply);
  }, []);
  return reduced;
}

export function OrbitRingFrame({
  style,
  hole = false,
  children,
}: {
  style?: CSSProperties;
  hole?: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  if (reduced) return children;
  const sharp = hole ? "orbit-ring orbit-ring--hole" : "orbit-ring";
  return (
    <span className="orbit-ring-host">
      <span className={hole ? "orbit-ring orbit-ring-halo orbit-ring-hole-box" : "orbit-ring orbit-ring-halo"} data-orbit-ring="" aria-hidden="true" style={style}>
        {hole ? (
          <span className="orbit-ring-hole">
            <span className="orbit-ring-spin" />
          </span>
        ) : (
          <span className="orbit-ring-spin" />
        )}
      </span>
      <span className={sharp} aria-hidden="true" style={style}>
        <span className="orbit-ring-spin" />
      </span>
      {children}
    </span>
  );
}

/** Circle around a mark that does not cover its own center (the terminal glyph). */
export function OrbitMark({ children }: { children: ReactNode }) {
  return (
    <OrbitRingFrame hole>
      {children}
    </OrbitRingFrame>
  );
}
