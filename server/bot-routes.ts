import { unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { BOT_AVATAR_PICKER_ORDER, botAvatarChoiceSchema, botAvatarUrlFromStoredPath } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { saveImage } from "./attachments.ts";
import { avatarGenerationRequestSchema, avatarGenerationStateMatches, generateAvatarImage, snapshotAvatarGenerationState } from "./avatar-image.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { parseBotProfilePatch } from "./bot-profile.ts";
import * as checkpoints from "./checkpoints.ts";
import { cloudBackendChangeError } from "./cloud-backend.ts";
import type { AppConfig } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { json, readBody } from "./http-helpers.ts";
import type { KeepGoing } from "./keep-going.ts";
import { applyEffortPick } from "./live-effort.ts";
import type { createMemoryHealthCheck } from "./memory-health.ts";
import { modelPickPatch } from "./pending-model.ts";
import { validateProjectNotes, type createProjectNotesCheck } from "./project-notes.ts";
import { fetchSkillFromSource } from "./skill-fetch.ts";
import { installSkill, listSkills, readSkillFile, removeSkill, setSkillEnabled } from "./skills.ts";
import { sectionKey, type BotRecord, type Message, type Store } from "./store.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { isMemoryTopicName, listMemoryTopics, MEMORY_FILE_MAX_BYTES, readMemoryFile, readMemoryTopic, saveMemoryFile } from "./workspace.ts";

type BotRouteDeps = {
  cfg: AppConfig;
  registry: ProviderRegistry;
  MAX_WORKSPACE_BOTS: number;
  defaultSelection: () => Promise<ModelSelection>;
  botJobSchema: z.ZodString;
  checkedModelSelection: (raw: unknown, existing?: boolean, requireAvailableModel?: boolean) => { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };
  store: Store;
  keepGoing: KeepGoing;
  wireBot: (bot: BotRecord) => Record<string, unknown>;
  storedAvatarExists: (avatarUrl: string) => boolean;
  clientMessage: (message: Message) => Message;
  broadcast: (payload: Record<string, unknown>) => void;
  taskPacketForWrite: (threadId: string) => TaskResumePacket | null;
  projectNotesCheck: ReturnType<typeof createProjectNotesCheck>;
  memoryHealthCheck: ReturnType<typeof createMemoryHealthCheck>;
  activeVpsThreads: Map<string, string>;
  checkpointRestoreLeases: Set<string>;
  resumePaneWakes: (botId: string) => void;
};

export function createBotRoutes(deps: BotRouteDeps) {
  const {
    cfg,
    registry,
    MAX_WORKSPACE_BOTS,
    defaultSelection,
    botJobSchema,
    checkedModelSelection,
    store,
    keepGoing,
    wireBot,
    storedAvatarExists,
    clientMessage,
    broadcast,
    taskPacketForWrite,
    projectNotesCheck,
    memoryHealthCheck,
    activeVpsThreads,
    checkpointRestoreLeases,
    resumePaneWakes,
  } = deps;
  return {
    order: async (req: IncomingMessage, res: ServerResponse) => {
      const parsed = z.object({ botIds: z.array(z.string()) }).safeParse(await readBody(req));
      if (!parsed.success || !store.reorderBots(parsed.data.botIds)) {
        return json(res, 400, { error: "botIds must list every bot exactly once" });
      }
      return json(res, 200, { botIds: parsed.data.botIds });
    },
    create: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "bot must be a JSON object" });
      }
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      let job: string | undefined;
      if (body.job !== undefined) {
        const parsedJob = botJobSchema.safeParse(body.job);
        if (!parsedJob.success) {
          return json(res, 400, { error: `job must be 1-${BOT_PROFILE_LIMITS.description} characters` });
        }
        job = parsedJob.data;
      }
      const profileInput = Object.fromEntries(
        ["name", "title", "description"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      );
      const profile = parseBotProfilePatch(profileInput, true);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          return json(res, 400, { error: "section must be at most 60 characters" });
        }
      }
      let selection: ModelSelection;
      if (body.modelSelection === undefined) {
        selection = await defaultSelection();
      } else {
        const checked = checkedModelSelection(body.modelSelection, false, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        selection = checked.selection;
      }
      // Keep the capacity check immediately beside the synchronous write.
      // Awaiting provider discovery before this point cannot race the cap.
      if (store.bots.length >= MAX_WORKSPACE_BOTS) {
        return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
      }
      const palette = [
        "green",
        "blue",
        "red",
        "orange",
        "purple",
        "cyan",
        "pink",
        "yellow",
        "teal",
        "coral",
        "white",
        "black",
        "gray",
      ] as const satisfies readonly BotRecord["color"][];
      const color = palette.find((name) => name === body.color);
      let mascotStyle: z.infer<typeof botAvatarChoiceSchema> | undefined;
      if (body.mascotStyle !== undefined) {
        const parsedStyle = botAvatarChoiceSchema.safeParse(body.mascotStyle);
        if (!parsedStyle.success) {
          return json(res, 400, {
            error: `mascotStyle must be one of ${BOT_AVATAR_PICKER_ORDER.join(", ")}`,
          });
        }
        mascotStyle = parsedStyle.data;
      }
      let cwd: string | undefined;
      if (body.cwd !== undefined) {
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        cwd = checked.cwd ?? undefined;
      }
      // no computer is set at create, so the local Auto acknowledgement cannot apply
      const createProfile: Parameters<typeof store.createBot>[0] = { ...profile.patch, section, modelSelection: selection, color, mascotStyle, autoApprove: true };
      if (cwd) createProfile.cwd = cwd;
      const bot = store.createBot(createProfile, { job });
      return json(res, 201, {
        bot: {
          ...wireBot(bot),
          messages: store.messagesFor(bot.threadId).map(clientMessage),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
    },
    generateAvatar: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      // Generation is slow and both desktop and companion clients may edit or
      // delete this bot while it is in flight. Snapshot the two fields this
      // request owns before the first await so a late result cannot win.
      const initialAvatar = snapshotAvatarGenerationState(existing);
      const parsed = avatarGenerationRequestSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: `prompt must be at most 400 characters` });
      }
      const generated = await generateAvatarImage(cfg.imageGen?.key ?? "", existing, parsed.data.prompt);
      const current = store.bot(existing.id);
      if (!current) return json(res, 404, { error: "no such bot" });
      if (!avatarGenerationStateMatches(initialAvatar, current)) {
        return json(res, 409, { error: "avatar changed while generation was in progress" });
      }
      const saved = saveImage(generated.bytes, generated.mime);
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw Object.assign(new Error("Could not store the generated avatar"), { status: 500 });
      const avatarCrop = initialAvatar.avatarCrop && initialAvatar.avatarCrop !== "mascot"
        ? initialAvatar.avatarCrop
        : "circle";
      const bot = store.patchBot(current.id, { avatarUrl, avatarCrop });
      if (!bot) {
        // There are no awaits between the refreshed lookup and this patch, but
        // keep the attachment invariant explicit if the store ever changes.
        try { unlinkSync(saved.path); } catch {}
        return json(res, 404, { error: "no such bot" });
      }
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 201, { avatarUrl, bot: visible });
    },
    patchProfile: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const parsed = parseBotProfilePatch(await readBody(req), true);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (parsed.patch.avatarUrl && !storedAvatarExists(parsed.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const bot = store.patchBot(m[1], parsed.patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    },
    read: async (res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.patchBot(m[1], { unread: false });
      if (!bot) return json(res, 404, { error: "no such bot" });
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    },
    setKeepGoing: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      if (typeof body.on !== "boolean") return json(res, 400, { error: "on must be true or false" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // Approval stays with this thread's task as its plan changes.
      if (body.on) {
        resumePaneWakes(bot.id);
        keepGoing.enable(bot.id, bot.threadId, taskPacketForWrite(bot.threadId));
      } else keepGoing.disable(bot.id);
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    },
    alwaysAllow: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!allowKey) return json(res, 400, { error: "allowKey required" });
      const pending = store.messagesFor(bot.threadId).some((message) =>
        message.card?.requestId &&
        !message.card.answered &&
        message.card.dismissed !== true &&
        message.card.allowKey === allowKey
      );
      if (!pending) {
        return json(res, 409, { error: "that grant is not on a pending approval for this bot" });
      }
      const updated = store.patchBot(bot.id, {
        alwaysAllow: [...new Set([...(bot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      })!;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    },
    patch: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const existingBot = store.bot(m[1]);
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      // Neither Codex (free-form string field) nor Grok (lazy, logs-only)
      // rejects an unknown effort level at their own boundary - this is the
      // only real gate, so it stays. But it fires only when the target
      // instance actually resolves. An instance that isn't there declares no
      // levels, and rejecting against that empty list would 400 the *whole*
      // request: this is the app's general-purpose bot endpoint, and
      // duplicateBot re-sends the source bot's entire modelSelection beside
      // its name, title and description, so a source engine that happens to
      // be offline would cost the copy all of them. Letting it through is
      // safe - startTurn refuses to run a turn on an unavailable instance
      // anyway, so an unverifiable level never reaches a CLI.
      const rawSelection = (body as Record<string, unknown>).modelSelection;
      if (body.requireAvailableModel === true && rawSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      let normalizedSelection: ModelSelection | undefined;
      if (rawSelection !== undefined) {
        const checked = checkedModelSelection(rawSelection, Boolean(existingBot), body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        normalizedSelection = checked.selection;
      }
      // Persona/profile fields reach prompts and paired clients. Both this
      // broad desktop endpoint and the paired-safe profile endpoint pass
      // through the same validation and clear-value normalization.
      const profile = parseBotProfilePatch(body);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      if (profile.patch.avatarUrl && !storedAvatarExists(profile.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const patch: Record<string, unknown> = {};
      Object.assign(patch, profile.patch);
      let section: string | undefined | null;
      if (body.section !== undefined) {
        if (body.section === null) section = null;
        else if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        else {
          const trimmed = body.section.trim();
          if (!trimmed) section = null;
          else if (trimmed.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
          else section = trimmed;
        }
      }
      for (const key of ["unread", "computer", "cloudBackend", "color", "mascotExpression", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.mascotStyle !== undefined) {
        if (body.mascotStyle === null || body.mascotStyle === "") {
          patch.mascotStyle = undefined;
        } else {
          const parsedStyle = botAvatarChoiceSchema.safeParse(body.mascotStyle);
          if (!parsedStyle.success) {
            return json(res, 400, {
              error: `mascotStyle must be one of ${BOT_AVATAR_PICKER_ORDER.join(", ")}`,
            });
          }
          patch.mascotStyle = parsedStyle.data;
        }
      }
      // one pinned message per thread; null/"" clears. The id is not
      // validated against the transcript here - a pin whose message was
      // edited to another branch or deleted simply resolves to nothing.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else return json(res, 400, { error: "pinnedMessageId must be a message id" });
      }
      if (section !== undefined) patch.section = section ?? undefined;
      if (body.chiefOfStaff === false) patch.chiefOfStaff = false;
      // per-bot gate on the workspace's connected apps (Composio)
      if (body.composio !== undefined) {
        if (typeof body.composio !== "boolean") return json(res, 400, { error: "composio must be true or false" });
        patch.composio = body.composio;
      }
      // per-bot gate on the app's built-in browser
      if (body.browser !== undefined) {
        if (typeof body.browser !== "boolean") return json(res, 400, { error: "browser must be true or false" });
        patch.browser = body.browser;
      }
      // which named browser session this bot uses; null/"" = its own
      if (body.browserProfile !== undefined) {
        if (body.browserProfile === null || body.browserProfile === "") patch.browserProfile = undefined;
        else if (
          typeof body.browserProfile === "string" &&
          (body.browserProfile === "guest" || (cfg.browserProfiles ?? []).some((profile) => profile.id === body.browserProfile))
        ) {
          patch.browserProfile = body.browserProfile;
        } else return json(res, 400, { error: "browserProfile must name an existing browser profile" });
      }
      if (body.shareTerminalWithChat !== undefined) {
        if (typeof body.shareTerminalWithChat !== "boolean") return json(res, 400, { error: "shareTerminalWithChat must be true or false" });
        patch.shareTerminalWithChat = body.shareTerminalWithChat;
      }
      if (body.leanStartup !== undefined) {
        if (typeof body.leanStartup !== "boolean") return json(res, 400, { error: "leanStartup must be true or false" });
        patch.leanStartup = body.leanStartup;
      }
      if (body.memoryNotes !== undefined) {
        if (typeof body.memoryNotes !== "boolean") return json(res, 400, { error: "memoryNotes must be true or false" });
        patch.memoryNotes = body.memoryNotes;
      }
      if (body.projectNotes !== undefined) {
        const notes = validateProjectNotes(body.projectNotes);
        if (!notes.ok) return json(res, 400, { error: notes.error });
        patch.projectNotes = notes.path ?? undefined;
      }
      if (
        body.computer !== undefined &&
        !["cloud", "vm", "local", "off"].includes(String(body.computer))
      ) {
        return json(res, 400, { error: "computer must be cloud, vm, local, or off" });
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {
        return json(res, 400, { error: "cloudBackend must be box or vps" });
      }
      if (body.autoStartVps !== undefined) {
        if (typeof body.autoStartVps !== "boolean") return json(res, 400, { error: "autoStartVps must be true or false" });
        patch.autoStartVps = body.autoStartVps;
      }
      if (body.chiefOfStaff !== undefined && typeof body.chiefOfStaff !== "boolean") {
        return json(res, 400, { error: "chiefOfStaff must be true or false" });
      }
      if (body.cloudBackend !== undefined) {
        const backendError = cloudBackendChangeError(Boolean(existingBot?.busy), activeVpsThreads.has(m[1]));
        if (backendError) return json(res, 409, { error: backendError });
      }
      // Capture before patchBot: it mutates the record in place, so
      // existingBot.cwd would already read the new value afterwards.
      let cwdBefore: string | undefined;
      if (body.cwd !== undefined) {
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        cwdBefore = existingBot?.cwd ?? undefined;
        patch.cwd = checked.cwd ?? undefined;
      }
      if (body.hidden === true && existingBot?.chiefOfStaff && body.chiefOfStaff !== false) {
        return json(res, 400, { error: "choose another Chief of Staff before hiding this bot" });
      }
      // the permission fields decide what runs unattended, so they are
      // type-checked rather than copied through: a string alwaysAllow would
      // still answer .includes() - with substring matches, not tool names
      if (body.autoApprove !== undefined) {
        if (typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be true or false" });
        patch.autoApprove = body.autoApprove;
      }
      if (body.autoReview !== undefined) {
        if (body.autoReview !== "off" && body.autoReview !== "shadow" && body.autoReview !== "enforce") {
          return json(res, 400, { error: "autoReview must be off, shadow, or enforce" });
        }
        patch.autoReview = body.autoReview;
      }
      // Requires acknowledgeLocalAuto so the desktop dialog can't be skipped
      // by accident. It proves a human saw the warning only when the caller
      // is that dialog - the server can't tell it apart from any other
      // holder of the API token, including a bot's own agent process, so
      // this is not a boundary against a hostile agent.
      const wantsComputer = body.computer !== undefined ? body.computer : existingBot?.computer;
      const wantsAuto = body.autoApprove !== undefined ? body.autoApprove : existingBot?.autoApprove === true;
      const alreadyGranted = existingBot?.computer === "local" && existingBot?.autoApprove === true;
      if (wantsComputer === "local" && wantsAuto === true && !alreadyGranted && body.acknowledgeLocalAuto !== true) {
        return json(res, 400, {
          error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)",
        });
      }
      if (body.approvePeerComms !== undefined) {
        if (typeof body.approvePeerComms !== "boolean") {
          return json(res, 400, { error: "approvePeerComms must be true or false" });
        }
        patch.approvePeerComms = body.approvePeerComms;
      }
      if (body.alwaysAllow !== undefined) {
        if (!Array.isArray(body.alwaysAllow) || body.alwaysAllow.some((t: unknown) => typeof t !== "string")) {
          return json(res, 400, { error: "alwaysAllow must be a list of tool keys" });
        }
        patch.alwaysAllow = [...new Set(body.alwaysAllow as string[])].slice(0, 200);
      }
      if (existingBot?.computer === "local" && body.computer !== undefined && body.computer !== "local") {
        await registry
          .get(existingBot.modelSelection.instanceId)
          ?.adapter.interruptTurn(existingBot.threadId)
          .catch(() => {});
      }
      const chiefMovedSections =
        Boolean(existingBot?.chiefOfStaff) &&
        body.chiefOfStaff !== false &&
        section !== undefined &&
        sectionKey(existingBot?.section) !== sectionKey(section);
      // After the awaits above, so the pick sees the bot's busy state now.
      if (normalizedSelection && existingBot) Object.assign(patch, modelPickPatch(existingBot, normalizedSelection));
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // A changed working folder must reach existing tasks: their pinned
      // cwd predates the change and their resume cursors point at
      // old-rooted CLI sessions. Reset both so the next turn re-pins the
      // new folder on a fresh session. Same value = no-op.
      if (body.cwd !== undefined && cwdBefore !== (bot.cwd ?? undefined)) {
        store.resetTasksForCwdChange(bot.id);
      }
      if (body.projectNotes !== undefined) void projectNotesCheck.refresh(bot.id);
      const chiefChanges =
        body.chiefOfStaff === true || chiefMovedSections
          ? store.setChiefOfStaff(bot.id)
          : [];
      if (chiefChanges === null) return json(res, 404, { error: "no such bot" });
      if (normalizedSelection) await applyEffortPick(store, registry, bot.id, normalizedSelection);
      return json(res, 200, { bot: wireBot(store.bot(bot.id) ?? bot) });
    },
    skills: async (res: ServerResponse, m: RegExpMatchArray) => {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { skills: listSkills(m[1]) });
    },
    addSkill: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub URL or owner/repo" });
      const fetched = await fetchSkillFromSource(parsed.data.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const results = fetched.skills.map((skill) => installSkill(m![1]!, skill.source, skill.files));
      const installed = results.filter((entry): entry is Exclude<typeof entry, { error: string }> => !("error" in entry));
      const errors = results.flatMap((entry) => ("error" in entry ? [entry.error] : []));
      if (!installed.length) return json(res, 422, { error: errors.join("; ") || "nothing importable found" });
      return json(res, 201, { installed, errors });
    },
    readSkill: async (res: ServerResponse, m: RegExpMatchArray) => {
      const text = readSkillFile(m[1]!, m[2]!);
      if (text === null) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { text });
    },
    patchSkill: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    },
    deleteSkill: async (res: ServerResponse, m: RegExpMatchArray) => {
      const result = removeSkill(m[1]!, m[2]!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { ok: true });
    },
    getMemory: async (res: ServerResponse, m: RegExpMatchArray) => {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { ...readMemoryFile(m[1]), topics: listMemoryTopics(m[1]) });
    },
    putMemory: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ text: z.string(), baseRevision: z.string().optional() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      if (Buffer.byteLength(parsed.data.text, "utf8") > MEMORY_FILE_MAX_BYTES) {
        return json(res, 400, {
          error: `memory is capped at ${MEMORY_FILE_MAX_BYTES / 1024}KB - move longer notes into memory/<topic>.md files`,
        });
      }
      const saved = saveMemoryFile(m[1], parsed.data.text, parsed.data.baseRevision);
      if (saved.conflict) return json(res, 409, { error: "conflict", text: saved.text, revision: saved.revision });
      memoryHealthCheck.refresh(m[1]);
      // truncated echoes back so the editor can warn about the load budget
      return json(res, 200, { ok: true, truncated: saved.truncated, revision: saved.revision });
    },
    memoryTopic: async (res: ServerResponse, m: RegExpMatchArray) => {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // Decode before validating: a UI-sent name arrives percent-encoded
      // ("my notes.md" → "my%20notes.md"), and an encoded traversal
      // ("..%2F..") must be judged by what it decodes TO, not slip through
      // as an opaque token. The name gate then rejects anything that is not
      // a single plain-markdown path segment.
      let name: string;
      try {
        name = decodeURIComponent(m[2]);
      } catch {
        return json(res, 400, { error: "invalid topic name" });
      }
      if (!isMemoryTopicName(name)) return json(res, 400, { error: "invalid topic name" });
      const text = readMemoryTopic(m[1], name);
      if (text === null) return json(res, 404, { error: "no such topic file" });
      return json(res, 200, { name, text });
    },
    listCheckpoints: async (res: ServerResponse, m: RegExpMatchArray, url: URL) => {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const cwd = url.searchParams.get("cwd") ?? "";
      if (!cwd.trim()) return json(res, 400, { error: "cwd query parameter required" });
      return json(res, 200, {
        checkpoints: await checkpoints.listCheckpoints(m[1]!, cwd),
        enabled: await checkpoints.checkpointsEnabled(m[1]!, cwd),
      });
    },
    restoreCheckpoint: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const parsed = z
        .object({ cwd: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{40}$/) })
        .safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "cwd (absolute path) and hash (full 40-character checkpoint hash) required" });
      }
      // Claim synchronously with the busy check. startTurn checks the same
      // lease before reserving the bot, so no turn can enter during the
      // awaited Git operation.
      if (bot.busy) return json(res, 409, { error: "the bot is working - stop the turn before restoring files" });
      if (checkpointRestoreLeases.has(bot.id)) {
        return json(res, 409, { error: "this bot's project files are already being restored" });
      }
      checkpointRestoreLeases.add(bot.id);
      let result: checkpoints.RestoreResult;
      try {
        result = await checkpoints.restore(bot.id, parsed.data.cwd, parsed.data.hash);
      } finally {
        checkpointRestoreLeases.delete(bot.id);
      }
      if (!result.ok) return json(res, 400, { error: result.error });
      return json(res, 200, { ok: true });
    },
  };
}
