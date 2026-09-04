// Bot avatar — four static cute mascot styles, wrapped in the historical
// MausAvatar API so call sites keep compiling. Animation stays parked:
// motion / expression / pointer props are accepted and ignored.
import { forwardRef, memo, useEffect, useImperativeHandle, useState } from "react";
import { type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { mascotDataUrl } from "@/lib/mascot-art";
import {
  botAvatarProfile,
  resolveMascotStyle,
  type BotAvatarCrop,
  type MascotStyle,
} from "../../shared/bot-avatar";

/** Legacy face-placement knobs — accepted, ignored. */
export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

export type MausAvatarHandle = {
  blink: () => void;
  spin: (durationMs?: number) => void;
  setExpression: (index: number) => void;
};

export type MausAvatarProps = {
  color: MausColor;
  mascotStyle?: MascotStyle | string | null;
  state?: MausState;
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  forward?: boolean;
  lookAround?: number;
  trackPointer?: boolean;
  animated?: boolean;
  eyeSpacing?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
};

function MausAvatarComponent(
  { color, mascotStyle, size = 44, label }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  useImperativeHandle(ref, () => ({
    blink: () => {},
    spin: () => {},
    setExpression: () => {},
  }));

  const style = resolveMascotStyle(mascotStyle, color);
  return (
    <span className="inline-flex shrink-0">
      <img
        src={mascotDataUrl(style, color)}
        alt={label ?? `${style} mascot`}
        width={size}
        height={size}
        draggable={false}
        className="block shrink-0"
        style={{ width: size, height: size }}
      />
    </span>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color" | "mascotStyle"> & {
  bot: {
    name?: string;
    color: MausColor;
    mascotStyle?: MascotStyle | string | null;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
  };
};

/**
 * The one renderer for a bot's chosen profile image. Malformed persisted
 * values and images that fail to load both fall back to the cute mascot,
 * so an old/corrupt profile can never leave a broken-image icon in the app.
 */
export function BotAvatar({ bot, size = 44, label, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  if (profile.avatarCrop === "mascot" || !profile.avatarUrl || imageFailed) {
    return (
      <MausAvatar
        {...mascotProps}
        color={bot.color}
        mascotStyle={bot.mascotStyle}
        size={size}
        label={label ?? bot.name}
      />
    );
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  return (
    <img
      src={profile.avatarUrl}
      alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
      width={size}
      height={size}
      draggable={false}
      onError={() => setImageFailed(true)}
      className="block shrink-0 bg-raised object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
