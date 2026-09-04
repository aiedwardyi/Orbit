import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image. */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/** Static cute faces that replaced the Cursor arrow-head silhouette. */
export const MASCOT_STYLES = ["peach", "teal", "lavender", "coral"] as const;
export const mascotStyleSchema = z.enum(MASCOT_STYLES);
export type MascotStyle = z.infer<typeof mascotStyleSchema>;
export const DEFAULT_MASCOT_STYLE = "peach" as const satisfies MascotStyle;

export const MASCOT_STYLE_ASSETS = {
  peach: "peach.svg",
  teal: "teal.svg",
  lavender: "lavender.svg",
  coral: "coral.svg",
} satisfies Record<MascotStyle, string>;

export const MASCOT_STYLE_LABELS = {
  peach: "Peach blob",
  teal: "Teal friend",
  lavender: "Lavender kitty",
  coral: "Coral bean",
} satisfies Record<MascotStyle, string>;

/** Existing arrow-head bots keep their color and receive a matching cute face. */
export function mascotStyleFromColor(color: string | null | undefined): MascotStyle {
  switch (color) {
    case "red":
    case "orange":
    case "yellow":
      return "peach";
    case "green":
    case "teal":
    case "cyan":
      return "teal";
    case "blue":
    case "purple":
      return "lavender";
    case "pink":
    case "coral":
      return "coral";
    default:
      return DEFAULT_MASCOT_STYLE;
  }
}

/** Stored style wins; missing or junk ids color-map so old profiles stay valid. */
export function resolveMascotStyle(style: string | null | undefined, color?: string | null): MascotStyle {
  const parsed = mascotStyleSchema.safeParse(style);
  if (parsed.success) return parsed.data;
  return mascotStyleFromColor(color);
}

/**
 * Custom avatars are deliberately limited to this app's attachment server.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel or a
 * script-capable SVG.
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/,
    "must be a stored PNG, JPEG, GIF, or WebP attachment",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
  mascotStyle?: unknown;
  color?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
  mascotStyle: MascotStyle;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const style = z.string().safeParse(value.mascotStyle);
  const color = z.string().safeParse(value.color);
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
    mascotStyle: resolveMascotStyle(style.success ? style.data : undefined, color.success ? color.data : undefined),
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  return profile;
}
