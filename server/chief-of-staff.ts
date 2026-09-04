export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
  section?: string;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits.
const ROSTER_MAX_BOTS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const sectionKey = (section?: string): string => section?.trim() || "";

/** Shared with every agents-tool bot: call the tools, do not probe the machine. */
export const AGENTS_TOOLS_DISCIPLINE =
  "Never scan the environment, ports, or processes to check whether your tools are connected, never invent localhost APIs, and never announce that a tool is unavailable before you have tried it. Call the agents tools.";

/** 1:1 / room framing for a non-Chief that still has agents tools. */
export function peerAgentsSystemPrompt(): string {
  return [
    "You can work with the other bots in your section through the agents tools — list_bots shows who's available, ask_bot sends one of them a message and returns their reply.",
    "If the user asks for a shared channel or two-bot room, call create_channel with yourself and the other bot(s) in member_ids.",
    AGENTS_TOOLS_DISCIPLINE,
  ].join(" ");
}

/** Dynamic system context for a section's Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  trustedOpenMausStatus = "",
  inRoom = false,
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_BOTS);
  const overflow = team.length - listed.length;
  const hasTeam = team.length > 0;
  const roster = hasTeam
    ? listed
        .map((bot) => {
          const name = clip(bot.name, ROSTER_NAME_MAX);
          const role = clip(bot.title?.trim() || "General assistant", ROSTER_ROLE_MAX);
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${name} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""} (${availability})`;
        })
        .join("\n") + (overflow > 0 ? `\n- …and ${overflow} more (use list_bots for the full roster).` : "")
    : "";

  const delegation = !canDelegate
    ? "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work."
    : hasTeam
      ? [
          "Use list_bots to confirm the live roster and IDs. Use ask_bot when a teammate is better suited to part of the request.",
          "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots.",
          "When they ask for a two-bot channel or shared channel, create_bot if a specialist is missing, then create_channel with yourself and the other bot(s). Use ask_bot for peer talk this turn; do not leave the user only in a new bot's 1:1.",
          "Delegate with a clear, self-contained brief and wait for the teammate's actual reply before claiming its work is complete.",
          "You may consult more than one teammate when the request genuinely benefits, then combine their results into one coherent answer.",
          AGENTS_TOOLS_DISCIPLINE,
        ].join(" ")
      : [
          "No other teammates are on this section yet. Answer the user directly. Do not inspect the team roster or create specialists unless the user asks you to involve or assemble teammates.",
          "If they ask you to involve a teammate, assemble a team, or start a two-bot channel or shared channel, call create_bot for the specialist, then create_channel with yourself and that bot.",
          AGENTS_TOOLS_DISCIPLINE,
        ].join(" ");

  // QA 13 / QA-ROOM-2: an in-room Chief used to hunt for its own tools in
  // public, dumping env vars and scanning ports before spawning. create_bot
  // still only files the new bot under the Chief's section; create_channel
  // is the tool that opens a room the user can talk in.
  const roomDiscipline =
    inRoom && canDelegate
      ? [
          "You are in a shared room where everyone sees your tool calls.",
          hasTeam ? "When you are asked to add a teammate, call create_bot directly." : "",
          "A teammate you add joins this section, not this room. Call create_channel with yourself and the new bot when the user wants a shared room. Use ask_bot rather than delegate_bot whenever you must report back in this room, including when the delegation guidance above or a tool result says otherwise: ask_bot waits and returns the reply for you to fold into your answer here, while delegations start only after this turn ends and so cannot produce the answer this room is waiting for. Mentioning someone who is not a room member does nothing.",
        ]
          .filter(Boolean)
          .join(" ")
      : "";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    roomDiscipline,
    hasTeam ? `Current ${sectionName} section team:` : "",
    roster,
    trustedOpenMausStatus,
  ].filter(Boolean).join("\n");
}
