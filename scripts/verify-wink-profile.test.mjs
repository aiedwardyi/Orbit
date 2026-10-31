import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSeedProfile } from "../.claude/skills/verify-wink/seed-profile.mjs";

const temporaryDirectories = [];
const SECRET = "fixture-secret";
const EXCLUDED = ["messages.db", "config.json", "google-binding.json", "device-name.json", "remote-key.json", "memory-sync-v2.json", "profile-sync.json", "picture-sync.json", "phone-ping.json", "web-push-subscriptions.json", "key-uses.json", "workspaces/bot-01/MEMORY.md", "attachments/chat-photo.png"];
const FIELDS = ["name", "instanceId", "model", "mode", "pinned", "hidden", "chiefOfStaff", "section", "color", "mascotStyle", "avatar", "avatarCrop"];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-verify-profile-"));
  temporaryDirectories.push(dir);
  fs.mkdirSync(path.join(dir, "attachments"));
  fs.mkdirSync(path.join(dir, "workspaces", "bot-01"), { recursive: true });
  for (const name of EXCLUDED) fs.writeFileSync(path.join(dir, name), JSON.stringify({ token: SECRET }));
  fs.writeFileSync(path.join(dir, "attachments", "avatar-01.png"), "png");
  const bots = Array.from({ length: 16 }, (_, at) => ({
    id: `bot-${String(at + 1).padStart(2, "0")}`,
    threadId: `thread-${at}`,
    name: `Bot ${at + 1}`,
    title: SECRET,
    description: SECRET,
    cwd: SECRET,
    resumeCursors: { claude: SECRET },
    alwaysAllow: [SECRET],
    color: "white",
    mascotStyle: "icon-12",
    modelSelection: at === 3 ? { mode: "automatic", instanceId: "grok", model: "grok-4.6", effort: "high" } : { mode: "pinned", instanceId: "claude", model: "claude-opus-5-5" },
    ...(at === 0 && { chiefOfStaff: true, section: "Lab", avatarUrl: "/api/attachments/avatar-01.png", avatarCrop: "mascot" }),
    ...(at >= 1 && at <= 3 && { pinned: true }),
    ...(at >= 4 && at <= 5 && { section: "Lab" }),
    ...(at === 6 && { avatarUrl: "/api/attachments/../config.json" }),
  }));
  fs.writeFileSync(path.join(dir, "bots.json"), JSON.stringify(bots));
  fs.writeFileSync(path.join(dir, "groups.json"), JSON.stringify([
    { id: "g1", threadId: "gt1", name: "Launch room", memberIds: ["bot-01", "bot-05", "gone"], defaultResponder: { kind: "member", botId: "bot-05" }, bulletin: SECRET, section: "Lab" },
    { id: "g2", threadId: "gt2", name: "Review room", memberIds: ["bot-02", "bot-03"], defaultResponder: { kind: "everyone" }, bulletin: SECRET },
    { id: "g3", threadId: "gt3", name: "Bot 1 ⇄ Bot 2", memberIds: ["bot-01", "bot-02"], defaultResponder: { kind: "everyone" }, bulletin: "", dm: true },
  ]));
  return dir;
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    return [name, stat.mtimeMs, stat.isFile() ? fs.readFileSync(file, "utf8") : null];
  });
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("verify-wink seed-profile", () => {
  it("keeps the sidebar profile in profile order", () => {
    const { bots, groups } = readSeedProfile(fixture());
    expect(bots.map((bot) => bot.name)).toEqual(Array.from({ length: 16 }, (_, at) => `Bot ${at + 1}`));
    expect(bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.name)).toEqual(["Bot 1"]);
    expect(bots.filter((bot) => bot.pinned)).toHaveLength(3);
    expect(bots.filter((bot) => !bot.pinned && !bot.chiefOfStaff)).toHaveLength(12);
    expect(new Set(bots.map((bot) => bot.section).filter(Boolean))).toEqual(new Set(["Lab"]));
    expect(bots[3]).toMatchObject({ instanceId: "grok", model: "grok-4.6", mode: "automatic" });
    expect(groups).toEqual([
      { name: "Launch room", members: [0, 4], section: "Lab", responder: 4 },
      { name: "Review room", members: [1, 2], section: undefined, responder: "everyone" },
    ]);
  });

  it("reads only the avatar images bots.json names", () => {
    const dir = fixture();
    const { bots } = readSeedProfile(dir);
    expect(bots[0].avatar).toEqual({ file: path.join(dir, "attachments", "avatar-01.png"), mime: "image/png" });
    expect(bots[0].avatarCrop).toBe("mascot");
    expect(bots.filter((bot) => bot.avatar)).toHaveLength(1);
  });

  it("copies no conversations, keys, memory or sync data and leaves the profile untouched", () => {
    const dir = fixture();
    const before = snapshot(dir);
    const profile = readSeedProfile(dir);
    expect(JSON.stringify(profile)).not.toContain(SECRET);
    for (const bot of profile.bots) expect(FIELDS).toEqual(expect.arrayContaining(Object.keys(bot)));
    for (const name of EXCLUDED) expect(JSON.stringify(profile)).not.toContain(path.basename(name));
    expect(snapshot(dir)).toEqual(before);
  });
});
