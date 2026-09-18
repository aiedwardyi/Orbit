import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image.
 *  `circle` here is a photo crop, not MASCOT_STYLES.circle. Distinct namespaces. */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/** Static cute faces that replaced the Cursor arrow-head silhouette.
 *  `circle` here is the round mascot, not BOT_AVATAR_CROPS.circle. Distinct namespaces. */
export const MASCOT_STYLES = ["peach", "teal", "lavender", "coral", "squircle", "circle", "pill"] as const;
export const mascotStyleSchema = z.enum(MASCOT_STYLES);
export type MascotStyle = z.infer<typeof mascotStyleSchema>;
export const DEFAULT_MASCOT_STYLE = "squircle" as const satisfies MascotStyle;

export const MASCOT_STYLE_ASSETS = {
  peach: "peach.svg",
  teal: "teal.svg",
  lavender: "lavender.svg",
  coral: "coral.svg",
  squircle: "squircle.svg",
  circle: "circle.svg",
  pill: "pill.svg",
} satisfies Record<MascotStyle, string>;

export const MASCOT_STYLE_LABELS = {
  peach: "Peach blob",
  teal: "Teal friend",
  lavender: "Lavender kitty",
  coral: "Coral bean",
  squircle: "Soft squircle",
  circle: "Soft circle",
  pill: "Soft pill",
} satisfies Record<MascotStyle, string>;

export const BOT_AVATAR_IDS = [
  "icon-01",
  "icon-02",
  "icon-03",
  "icon-04",
  "icon-05",
  "icon-06",
  "icon-07",
  "icon-08",
  "icon-09",
  "icon-10",
  "icon-11",
  "icon-12",
  "icon-13",
  "icon-14",
  "icon-15",
  "icon-16",
  "icon-17",
  "icon-18",
  "icon-19",
  "icon-20",
  "icon-21",
  "icon-22",
  "icon-23",
  "icon-24",
  "icon-25",
  "icon-26",
  "icon-27",
  "icon-28",
  "icon-29",
  "icon-30",
] as const;
export const botAvatarIdSchema = z.enum(BOT_AVATAR_IDS);
export type BotAvatarId = z.infer<typeof botAvatarIdSchema>;
export type BotAvatarChoice = MascotStyle | BotAvatarId;
export const botAvatarChoiceSchema = z.union([mascotStyleSchema, botAvatarIdSchema]);

export const BOT_AVATAR_ASSETS = {
  "icon-01": "icon-01-cobalt-planet.png",
  "icon-02": "icon-02-phosphor.png",
  "icon-03": "icon-03-amber-tui.png",
  "icon-04": "icon-04-calm-dark.png",
  "icon-05": "icon-05-ledger-white.png",
  "icon-06": "icon-06-pure-white-ink.png",
  "icon-07": "icon-07-soft-graphite.png",
  "icon-08": "icon-08-tokyo-lavender.png",
  "icon-09": "icon-09-ice-blue.png",
  "icon-10": "icon-10-mint-field.png",
  "icon-11": "icon-11-peach-warm.png",
  "icon-12": "icon-12-mono-O.png",
  "icon-13": "icon-13-mono-O-invert.png",
  "icon-14": "icon-14-double-ring.png",
  "icon-15": "icon-15-soft-squircle-face.png",
  "icon-16": "icon-16-pill-orbit.png",
  "icon-17": "icon-17-gem-crystal.png",
  "icon-18": "icon-18-terminal-block.png",
  "icon-19": "icon-19-soft-cloud.png",
  "icon-20": "icon-20-sunrise.png",
  "icon-21": "icon-21-star-burst.png",
  "icon-22": "icon-22-radar-rings.png",
  "icon-23": "icon-23-hex-badge.png",
  "icon-24": "icon-24-half-moon.png",
  "icon-25": "icon-25-pixel-bot.png",
  "icon-26": "icon-26-crescent-orbit.png",
  "icon-27": "icon-27-delta-mark.png",
  "icon-28": "icon-28-wave-bars.png",
  "icon-29": "icon-29-infinity-knot.png",
  "icon-30": "icon-30-shield-orbit.png",
} satisfies Record<BotAvatarId, string>;

export const BOT_AVATAR_LABELS = {
  "icon-01": "Cobalt planet",
  "icon-02": "Phosphor",
  "icon-03": "Amber TUI",
  "icon-04": "Calm dark",
  "icon-05": "Ledger white",
  "icon-06": "Pure white ink",
  "icon-07": "Soft graphite",
  "icon-08": "Tokyo lavender",
  "icon-09": "Ice blue",
  "icon-10": "Mint field",
  "icon-11": "Peach warm",
  "icon-12": "Mono O",
  "icon-13": "Mono O invert",
  "icon-14": "Double ring",
  "icon-15": "Soft squircle face",
  "icon-16": "Pill orbit",
  "icon-17": "Gem crystal",
  "icon-18": "Terminal block",
  "icon-19": "Soft cloud",
  "icon-20": "Sunrise",
  "icon-21": "Star burst",
  "icon-22": "Radar rings",
  "icon-23": "Hex badge",
  "icon-24": "Half moon",
  "icon-25": "Pixel bot",
  "icon-26": "Crescent orbit",
  "icon-27": "Delta mark",
  "icon-28": "Wave bars",
  "icon-29": "Infinity knot",
  "icon-30": "Shield orbit",
} satisfies Record<BotAvatarId, string>;

/** Fixed artwork first, with white and mono marks leading the picker. */
export const BOT_AVATAR_PICKER_ORDER = [
  "icon-05",
  "icon-06",
  "icon-12",
  "icon-13",
  "icon-21",
  "icon-26",
  "icon-01",
  "icon-02",
  "icon-03",
  "icon-04",
  "icon-07",
  "icon-08",
  "icon-09",
  "icon-10",
  "icon-11",
  "icon-14",
  "icon-15",
  "icon-16",
  "icon-17",
  "icon-18",
  "icon-19",
  "icon-20",
  "icon-22",
  "icon-23",
  "icon-24",
  "icon-25",
  "icon-27",
  "icon-28",
  "icon-29",
  "icon-30",
  "peach",
  "teal",
  "lavender",
  "coral",
  "squircle",
  "circle",
  "pill",
] as const satisfies readonly BotAvatarChoice[];

const BOT_AVATAR_ID_SET = new Set<string>(BOT_AVATAR_IDS);

export function isBotAvatarId(value: BotAvatarChoice): value is BotAvatarId {
  return BOT_AVATAR_ID_SET.has(value);
}

export function botAvatarAssetPath(id: BotAvatarId): string {
  return `/avatars/${BOT_AVATAR_ASSETS[id]}`;
}

/** Existing arrow-head bots keep their color and receive a matching cute face. */
export function mascotStyleFromColor(color: string | null | undefined): MascotStyle {
  switch (color) {
    case "red":
    case "orange":
    case "yellow":
    case "white":
    case "black":
    case "gray":
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
      return "peach";
  }
}

/** Stored style wins; missing or junk ids color-map so old profiles stay valid. */
export function resolveMascotStyle(style: string | null | undefined, color?: string | null): MascotStyle {
  const parsed = mascotStyleSchema.safeParse(style);
  if (parsed.success) return parsed.data;
  return mascotStyleFromColor(color);
}

export function resolveBotAvatarChoice(
  style: string | null | undefined,
  color?: string | null,
): BotAvatarChoice {
  const parsed = botAvatarChoiceSchema.safeParse(style);
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
  mascotStyle: BotAvatarChoice;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const style = z.string().safeParse(value.mascotStyle);
  const color = z.string().safeParse(value.color);
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
    mascotStyle: resolveBotAvatarChoice(style.success ? style.data : undefined, color.success ? color.data : undefined),
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  return profile;
}
