import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AVATAR = /^\/api\/attachments\/([\w-]+\.(png|jpe?g|gif|webp))$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Opens only bots.json, groups.json and the avatar images bots.json names, read-only.
export function readSeedProfile(dir) {
  const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : []);
  const records = read("bots.json");
  if (!Array.isArray(records)) throw new Error(`${join(dir, "bots.json")} is not a bot list`);
  const index = new Map(records.map((bot, at) => [bot.id, at]));
  const bots = records.map((bot) => {
    const [, file, ext] = AVATAR.exec(bot.avatarUrl ?? "") ?? [];
    const image = file && join(dir, "attachments", file);
    return {
      name: bot.name,
      instanceId: bot.modelSelection?.instanceId,
      model: bot.modelSelection?.model,
      mode: bot.modelSelection?.mode ?? "pinned",
      pinned: Boolean(bot.pinned),
      hidden: Boolean(bot.hidden),
      chiefOfStaff: Boolean(bot.chiefOfStaff),
      section: bot.section,
      color: bot.color,
      mascotStyle: bot.mascotStyle,
      ...(image && existsSync(image) && { avatar: { file: image, mime: MIME[ext.toLowerCase()] }, avatarCrop: bot.avatarCrop }),
    };
  });
  // Bot-to-bot channels are skipped: the API cannot create them and the sidebar hides them until the person posts there.
  const groups = read("groups.json").filter((group) => !group.dm).map((group) => {
    const responder = group.defaultResponder ?? { kind: "everyone" };
    return {
      name: group.name,
      members: group.memberIds.filter((id) => index.has(id)).map((id) => index.get(id)),
      section: group.section,
      responder: responder.kind === "member" ? (index.get(responder.botId) ?? "everyone") : responder.kind,
    };
  });
  return { bots, groups: groups.filter((group) => group.members.length) };
}
