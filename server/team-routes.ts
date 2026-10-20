import type { IncomingMessage, ServerResponse } from "node:http";
import { validateBotCwd } from "./bot-cwd.ts";
import { fetchBotDirectory, matchDirectoryBots, type MatchedDirectoryBot } from "./bot-directory.ts";
import { isBotPackage, packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import type { AppConfig } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { json, readBody } from "./http-helpers.ts";
import { createBotPackageExport } from "./package-export.ts";
import { scoutProject, suggestTeam } from "./project-scout.ts";
import type { RoutineManager } from "./routines.ts";
import type { BotRecord, GroupRecord, Store } from "./store.ts";
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "./team-library.ts";
import { createTeamManifest, importedMemberProfile, parseTeamManifest } from "./team-manifest.ts";

type TeamRouteDeps = {
  cfg: AppConfig;
  store: Store;
  routines: RoutineManager;
  defaultSelection: () => Promise<ModelSelection>;
  publicBot: (bot: BotRecord) => Record<string, unknown>;
  publicGroupState: (group: GroupRecord) => Record<string, unknown>;
  broadcast: (payload: Record<string, unknown>) => void;
};

export function createTeamRoutes(deps: TeamRouteDeps) {
  const { cfg, store, routines, defaultSelection, publicBot, publicGroupState, broadcast } = deps;
  return {
    exportTeam: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const profileName = cfg.profile?.name?.trim();
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : profileName
            ? `${profileName}'s Team`
            : "My OpenMaus Team";
      const memberIds = store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id);
      if (memberIds.length === 0) return json(res, 400, { error: "Create a bot before exporting your team" });
      try {
        if (body.format === "package") {
          const document = createBotPackageExport({
            name,
            authorName: profileName,
            bots: store.bots,
            groups: store.groups,
            routines: routines!.listRoutines(),
          });
          return json(res, 200, {
            name: document.package.name,
            members: document.package.agents.length,
            markdown: renderBotPackageMarkdown(document),
          });
        }
        return json(
          res,
          200,
          createTeamManifest(
            {
              name,
              memberIds,
            },
            store.bots,
          ),
        );
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
      }
    },
    catalog: async (res: ServerResponse) => {
      try {
        return json(res, 200, await fetchTeamCatalog());
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
      }
    },
    libraryTeam: async (res: ServerResponse, m: RegExpMatchArray) => {
      try {
        return json(res, 200, await fetchLibraryTeam(m[1]));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 502;
        return json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
      }
    },
    github: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      if (typeof body.url !== "string" || !body.url.trim()) {
        return json(res, 400, { error: "A GitHub URL is required" });
      }
      try {
        return json(res, 200, await fetchGithubTeam(body.url));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 400;
        return json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
      }
    },
    scout: async (res: ServerResponse, url: URL) => {
      // The scout reads a folder and answers with a suggestion — it creates
      // nothing. Bots and the room come into being only when the human sends
      // the suggested manifest through /api/teams/import, so "the agent
      // proposes, the person imports" is enforced by the route split itself.
      // The folder is whatever validateBotCwd accepts: the same local-user
      // trust boundary as pointing any bot's working folder at a path.
      // Deliberately offline — the community directory lives on its own
      // route below, so a slow network can never delay the suggestion.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      const profile = scoutProject(validated.cwd);
      return json(res, 200, { profile, suggestion: suggestTeam(profile) });
    },
    directory: async (res: ServerResponse, url: URL) => {
      // Community bots that fit the scouted folder — a separate, lazy call
      // so an unreachable directory degrades to "no extra candidates", never
      // to a broken scout.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      let directory: MatchedDirectoryBot[] = [];
      try {
        directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
      } catch (error) {
        // an unreachable directory is a fact of life, not an error — but an
        // empty section should still be diagnosable from the server log
        console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
      }
      return json(res, 200, { directory });
    },
    importTeam: async (req: IncomingMessage, res: ServerResponse, url: URL) => {
      // Import is additive-only. A manifest is untrusted input (catalog,
      // GitHub, a shared file), so it must be structurally unable to reach
      // records the user already has: every member becomes a NEW bot with a
      // fresh id — a manifest cannot name, update, or merge into an existing
      // bot or room, and importing the same file twice simply creates a
      // second, freshly numbered set (an edit the user made to the first set
      // is theirs and stays). Replace mode does hide the current team, but
      // that archive is driven by the mode parameter the user chose and
      // touches only hidden/chiefOfStaff on their own bots — nothing in the
      // file decides what gets archived or how.
      const importMode = url.searchParams.get("mode") ?? "add";
      if (importMode !== "add" && importMode !== "replace" && importMode !== "project") {
        return json(res, 400, { error: "Team import mode must be add, replace, or project" });
      }
      // `project` adds the team AND opens a caller-owned room on a folder.
      // Legacy team manifests remain people-only. Full bot packages may add
      // their own new rooms, but neither format can point at an existing room
      // or choose a local folder; workspace access always comes from this
      // explicit caller parameter.
      let projectCwd: string | null = null;
      if (importMode === "project") {
        const requested = url.searchParams.get("cwd");
        if (requested !== null) {
          const validated = validateBotCwd(requested);
          if (!validated.ok) return json(res, 400, { error: validated.error });
          projectCwd = validated.cwd;
        }
      }
      const body = await readBody(req);
      let packageDocument: ReturnType<typeof parseBotPackage> | null = null;
      let manifest: ReturnType<typeof parseTeamManifest> | null = null;
      try {
        if (isBotPackage(body)) packageDocument = parseBotPackage(body);
        else manifest = parseTeamManifest(body);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
      }
      const pkg = packageDocument?.package;
      const importName = pkg?.name ?? manifest!.team.name;
      const sourceMembers = pkg
        ? pkg.agents.map((agent) => ({ member: packageAgentAsMember(agent), playbookKeys: agent.playbooks ?? [] }))
        : manifest!.team.members.map((member) => ({ member, playbookKeys: [] as string[] }));

      // Snapshot before creating anything so replace never archives the new
      // team. Old bots are hidden only after every new bot was created; a
      // failed import therefore leaves the current workspace untouched.
      const archived = importMode === "replace"
        ? store.bots
            .filter((bot) => !bot.hidden)
            .map((bot) => ({ id: bot.id, chiefOfStaff: Boolean(bot.chiefOfStaff) }))
        : [];
      const importedBots: ReturnType<typeof store.createBot>[] = [];
      const createdGroups: GroupRecord[] = [];
      const createdRoutineIds: string[] = [];
      // Names already in use, hidden bots included: an archived bot can be
      // un-archived later, and a revived duplicate would be just as
      // ambiguous then. In replace mode this means re-importing your own
      // export numbers the newcomers ("Mira 2") — the old team is only
      // hidden, not gone, and Undo must never surface two bots wearing the
      // same name.
      const takenNames = new Set(store.bots.map((bot) => bot.name.trim().toLowerCase()));
      const memberIds = new Map<string, string>();
      let group: GroupRecord | undefined;
      try {
        const selection = await defaultSelection();
        const existingSections = new Set(
          [...store.bots.map((bot) => bot.section), ...store.groups.map((candidate) => candidate.section)]
            .filter((section): section is string => Boolean(section?.trim()))
            .map((section) => section.toLowerCase()),
        );
        let packageSection = pkg?.name;
        if (packageSection) {
          const stem = packageSection;
          for (let suffix = 2; existingSections.has(packageSection.toLowerCase()); suffix++) {
            packageSection = `${stem} ${suffix}`;
          }
        }
        const playbookByKey = new Map((pkg?.playbooks ?? []).map((playbook) => [playbook.key, playbook]));
        for (const source of sourceMembers) {
          const member = source.member;
          // importedMemberProfile is the authority boundary: persona fields
          // only, colliding names numbered. seedMessages: false — an
          // imported bot must not open by greeting the user as though it
          // were new. composio: false — a shared persona never starts with
          // reach into the user's connected apps (absence would mean
          // allowed); the user can switch it on per bot after reading who
          // they got.
          const created = store.createBot(
            {
              ...importedMemberProfile(member, takenNames),
              modelSelection: selection,
              ...(packageSection ? { section: packageSection } : {}),
            },
            { seedMessages: false },
          );
          const installedPlaybooks = source.playbookKeys.flatMap((key) => {
            const playbook = playbookByKey.get(key);
            return playbook ? [{ ...playbook }] : [];
          });
          store.patchBot(created.id, {
            composio: false,
            ...(installedPlaybooks.length ? { playbooks: installedPlaybooks } : {}),
            ...(pkg
              ? {
                  installedPackage: {
                    id: pkg.id,
                    name: pkg.name,
                    release: pkg.release,
                    requiredApps: pkg.requirements.apps.map((app) => ({ ...app })),
                  },
                }
              : {}),
          });
          importedBots.push(created);
          memberIds.set(member.key, created.id);
        }

        // A package is an explicit structure import: its rooms are created
        // from package-local keys only, then normalized to fresh bot ids.
        for (const room of pkg?.rooms ?? []) {
          const ids = room.members.map((key) => memberIds.get(key)!);
          let created = store.createGroup(room.name, ids, false, packageSection);
          const defaultResponder = room.defaultResponder.kind === "agent"
            ? { kind: "member" as const, botId: memberIds.get(room.defaultResponder.agent)! }
            : { kind: room.defaultResponder.kind } as const;
          created = store.patchGroup(created.id, {
            bulletin: room.bulletin ?? "",
            defaultResponder,
            setupCompletedAt: Date.now(),
          }) ?? created;
          createdGroups.push(created);
        }

        for (const routine of pkg?.routines ?? []) {
          const created = routines!.create({
            name: routine.name,
            prompt: routine.prompt,
            botId: memberIds.get(routine.agent)!,
            runOn: routine.runOn,
            enabled: false,
            schedule: routine.schedule,
            durationMinutes: routine.durationMinutes,
          });
          createdRoutineIds.push(created.id);
        }

        if (pkg?.chiefOfStaff) {
          store.setChiefOfStaff(memberIds.get(pkg.chiefOfStaff)!);
        }

        // The room is created last, so a failure anywhere above leaves no
        // half-built project behind — the catch below deletes the bots and
        // there is no room pointing at them.
        if (!pkg && importMode === "project" && importedBots.length > 0) {
          const roomName = url.searchParams.get("room")?.trim() || manifest!.team.name;
          group = store.createGroup(roomName, importedBots.map((bot) => bot.id));
          if (projectCwd) {
            // `cwd` is the folder the room WANTS; the store pins it on the
            // first turn (pinGroupCwd). Setting the pin here would decide it
            // before anyone has worked, which is the store's call, not ours.
            group = store.patchGroup(group.id, { cwd: projectCwd }) ?? group;
          }
          broadcast({ kind: "group", group: publicGroupState(group) });
          createdGroups.push(group);
        }

        // Archive only after the complete new structure exists. A package
        // that fails validation or persistence never disturbs the current
        // workspace.
        const archivedBots = archived.flatMap(({ id }) => {
          const bot = store.patchBot(id, { hidden: true, chiefOfStaff: false });
          return bot ? [publicBot(bot)] : [];
        });
        const publicBots = importedBots.map((bot) => publicBot(store.bot(bot.id)!));
        for (const bot of archivedBots) broadcast({ kind: "bot", bot });
        for (const bot of publicBots) broadcast({ kind: "bot", bot });

        return json(res, 201, {
          name: importName,
          bots: publicBots,
          archivedBots,
          archived,
          group,
          groups: createdGroups.map((created) => ({ ...created, messages: [] })),
          routines: createdRoutineIds.flatMap((id) => routines!.listRoutines().filter((routine) => routine.id === id)),
        });
      } catch (error) {
        // A room of deleted members must not survive either — patchGroup can
        // throw (disk) after createGroup already saved.
        for (const routineId of createdRoutineIds) routines!.remove(routineId);
        for (const created of createdGroups) store.deleteGroup(created.id);
        for (const bot of importedBots) store.deleteBot(bot.id);
        throw error;
      }
    },
  };
}
