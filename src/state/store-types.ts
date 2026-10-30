import type { CloudBackend, EffortLevel, RateLimitWindow } from "../../server/contracts.ts";
import type { MausColor, MausMotion } from "@/lib/mascot";
import type { BotAvatarChoice, BotAvatarCrop } from "../../shared/bot-avatar";
import type { RoutineRequestCardData } from "../../shared/routine-request";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { ToolDetail } from "../../shared/tool-detail";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import type { NotificationTarget, TerminalAttentionReason } from "@/lib/notify";
import type { SidebarOrder } from "@/lib/sidebar-order";
import type { BotUpdatePatch } from "./bot-patch-queue";
import type { AcceptedSends } from "@/lib/send-accept";
import type { StreamBuffers, StreamRamp } from "@/lib/turn-stage";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** A bot's non-blocking ask_user question; see lib/open-question. */
  askUser?: true;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  approvalScope?: "local-computer";
  /** Persisted proposal used by the server when the user confirms it. */
  routineRequest?: RoutineRequestCardData;
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  target: import("../../shared/credential-request").CredentialId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  /** Custom keys only: the site the saved key is locked to. */
  service?: import("../../shared/credential-request").CustomService;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "compaction" | "note" | "launch";
  text?: string;
  /** Versioned model-context state. Unknown versions stay intact on disk. */
  compaction?: unknown;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** Lifecycle mirror for a routine whose real work lives in a fresh task. */
  routineRun?: RoutineRunCardData;
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
  tool?: {
    name: string;
    /** Claude Code tool name, when the engine said the kind. */
    verb?: string;
    ok?: boolean;
    spoken?: string;
    summary?: string;
    durationMs?: number;
    detail?: ToolDetail;
    setup?: boolean;
    signIn?: boolean;
    folder?: string;
    usageLimit?: { resetsAt: number | null };
    usageWait?: import("../../server/limit-wait-store").UsageWaitView;
  };
  /** user messages sent into a running turn - the model saw it mid-turn */
  steered?: boolean;
  /** The engine replaced a longer mid-turn note with this short text. */
  summarized?: boolean;
  /** Client-only accepted send; replaced by the canonical transcript row. */
  placeholder?: true;
  streamWhole?: number;
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  /** a screen message published by show_image: never pruned, always shown */
  shown?: boolean;
  /** show_image: the attachment name its pixels load from */
  image?: string;
  /** A paged copy left the pixels out; they load from the image endpoint. */
  hasImage?: boolean;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace - that's a fork. */
  parentId?: string | null;
  /** Flat reply reference for an inline quote; unrelated to branch ancestry. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: MausColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: MausColor; peer?: "message" | "reply" | "from" };
  /** sent while the bot was mid-turn; auto-sends when the turn settles.
   * Rendered only while the bot is busy, so a flag stranded by a server
   * restart never shows a promise nothing will keep. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. Pending chips
   * match on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** A room: several bots + you in one shared thread. */
export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  readAt?: number;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  /** the room's shared desk - where member turns run their shell tools,
   * overriding each member's own folder; absent = each member's own */
  cwd?: string;
  /** folder the room's turns actually run in, pinned on the first turn;
   * null = each member's own default; absent = not pinned yet */
  pinnedCwd?: string | null;
  /** the one message pinned to the top of this room's transcript */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under (shared with bots) */
  section?: string;
  /** New user-created rooms remain in setup until Save or Skip. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** Separate conversations in this channel. DMs deliberately stay on one
   * thread and omit this collection. */
  tasks?: GroupTask[];
  /** Live Continuity record for the active room thread (DMs have no tasks). */
  taskState?: TaskResumePacket;
  /** True while a member turn or queued room operation is in flight. */
  working?: boolean;
  messages: Message[];
  /** The server holds older messages than `messages` starts with. */
  hasMore?: boolean;
}

/** One of a channel's independent conversations. The channel's threadId
 * points at the active one; folder and pin state belong to the task. */
export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  taskState?: TaskResumePacket;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  /** Existing bots without a mode remain pinned. */
  mode?: "automatic" | "pinned";
  effort?: EffortLevel;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
  /** what this task has spent, banked once per settled turn */
  usage?: TaskUsage;
  /** folder this task's turns run in, pinned on its first turn; null =
   * legacy home-folder session; absent = not pinned yet */
  cwd?: string | null;
  taskState?: TaskResumePacket;
}

export interface TaskResumePacket {
  v: 1;
  threadId: string;
  botId: string;
  goal: string;
  plan: Array<{ step: string; status: "pending" | "active" | "done" | "skipped" }>;
  completed: Array<{ note: string; at: number }>;
  evidence: Array<{ kind: "message" | "tool" | "file" | "url"; ref: string; note?: string }>;
  artifacts: Array<{ ref: string; label: string }>;
  blockers: Array<{ kind: "approval" | "login" | "input" | "engine"; note: string }>;
  nextAction: string;
  /** newest instruction, and the one the newest completion settled */
  instructionId?: string;
  settledInstructionId?: string;
  updatedAt: number;
  updatedBy: "harness" | "bot";
  flushReason: "turn-end" | "progress" | "approval" | "stop" | "engine-switch" | "crash" | "pre-compaction" | "shutdown";
  lastEventId?: string;
  turnsAtWrite: number;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** cached share of `input` (context the model re-read); absent on records
   * from builds before it was tracked */
  cachedInput?: number;
  /** null until any turn reported a cost - most engines never do; records
   * from builds before cost existed lack the field entirely */
  costUsd: number | null;
  turns: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** every context this bot has, newest first */
  tasks?: Task[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  /** A legacy recolorable face or a fixed built-in pack icon. */
  mascotStyle?: BotAvatarChoice | null;
  /** App-owned image attachment used for this bot's profile. */
  avatarUrl?: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  readAt?: number;
  busy?: boolean;
  /** Thread startTurn is actually running, when busy. Null if idle or unknown. */
  workingThreadId?: string | null;
  /** what the bot is doing, as the harness sees it; busy is derived from it */
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  /** The engine running this bot's turns; display reads shownModelSelection. */
  modelSelection: ModelSelection;
  /** Picked mid-reply; the server applies it when the reply ends. */
  pendingModelSelection?: ModelSelection | null;
  /** Skip user skills, plugins and plugin MCP servers at startup. */
  leanStartup?: boolean;
  /** Notes file the bot keeps current; null once cleared. */
  projectNotes?: string | null;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Allow Auto to prepare/start the managed VPS container. Off by default. */
  autoStartVps?: boolean;
  /** where new tasks run their shell tools; absent/null = the private bot workspace */
  cwd?: string | null;
  /** Chat-named folder remembered for the next task; this task's cwd stays. */
  rememberedProjectCwd?: string;
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** optional model review for otherwise undecided, attended approvals */
  autoReview?: "off" | "shadow" | "enforce";
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Sidebar section this bot renders under; absent = unsectioned. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** This sidebar section's primary coordinator. */
  chiefOfStaff?: boolean;
  /** When this bot wants to talk to another bot (ask_bot/delegate_bot),
   * pause and ask the user first. Off by default. */
  approvePeerComms?: boolean;
  /** Background notes from chat into MEMORY.md. Unset follows features.memoryNotes. */
  memoryNotes?: boolean;
  /** Whether this bot may use the workspace's connected apps. Unset means
   * allowed for existing bots; imported bots start with this disabled. */
  composio?: boolean;
  /** Whether this bot gets the app's built-in browser (Browser tab). On unless switched off. */
  browser?: boolean;
  /** Named browser profile id (config.browserProfiles); absent/null = the
   * bot's own session (null is how a clear travels over PATCH). */
  browserProfile?: string | null;
  /** Allow this bot's provider to read its own Orbit terminal screen. */
  shareTerminalWithChat?: boolean;
  /** null = off. Server-owned; toggled through /keep-going, never the bot PATCH. */
  keepGoing?: { paused: "no-progress" | "bot-paused" | "other-pc" | "task-changed" | "usage-unknown" | "usage-stale" | null } | null;
  messages: Message[];
  /** The server holds older messages than `messages` starts with. */
  hasMore?: boolean;
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

export interface TerminalAttention {
  botId: string;
  sessionId: string;
  reason: TerminalAttentionReason;
  receivedAt: number;
}

export type TerminalAttentionMap = Record<string, TerminalAttention>;

/** GET /api/config - configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  gemini?: { configured: boolean };
  openaiCompat?: { configured: boolean };
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  box: { configured: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  localVm: { mode: "shared" | "per-bot"; maxInstances: number };
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: { configured: boolean; ready: boolean; voice: string; provider?: "elevenlabs" | "system" };
  /** Shared write-only credential for on-demand GPT Image avatars. */
  imageGen?: { configured: boolean };
  anthropic?: { configured: boolean };
  vertex?: { configured: boolean };
  customKeys?: { host: string; name: string }[];
  /** who's using the app - collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string; avatarUrl?: string; googlePhoto?: boolean };
  /** Opt-in flags. Absent means off, except memoryNotes. */
  features?: { skillRecorder: boolean; showToolCalls?: boolean; detailedReplies?: boolean; browser?: boolean; memoryNotes?: boolean; terminalHost?: boolean };
  /** Named browser sessions any bot can be pointed at. */
  browserProfiles?: BrowserProfile[];
}

export interface BrowserProfile {
  id: string;
  name: string;
}

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "gemini" | "openaiCompat" | "composio" | "box" | "vps" | "rooms" | "localVm" | "tts" | "imageGen" | "anthropic" | "vertex" | "customKeys" | "profile" | "features" | "browserProfiles"
>;

/** How an engine gets installed - declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  login?: { args: string[]; deviceArgs?: string[]; env?: Record<string, string>; authHosts?: string[] };
  logout?: string[];
  needsNode?: boolean;
}

export interface RateLimitReport {
  windows: RateLimitWindow[];
  observedAt: string;
}

/** One row of GET /api/instances - the model picker's data. */
export interface InstanceInfo {
  loginState?: "pending" | "complete" | "failed" | "cancelled";
  loginCapture?: { url?: string; code?: string };
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    /** email or account name of the sign-in, when the CLI names one */
    account?: string;
    version?: string | null;
    /** a reported cost on a subscription is notional; the UI says so */
    billing?: "metered" | "subscription";
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    /** the engine keeps a live session and takes a message mid-turn */
    queueing?: boolean;
    localComputerMcp?: boolean;
    /** false when the engine can never ask before an edit or command */
    askApproval?: boolean;
    /** This engine can answer a bounded review prompt without changing the
     * bot's active conversation. */
    approvalReview?: boolean;
    /** the driver forwards the account's subscription windows; without it
     * the Usage screen says the engine does not report a limit */
    rateLimits?: boolean;
  };
  /** `custom` agents sit below the rail divider - no subscription catalog. */
  access?: "subscription" | "custom";
  /** newest subscription-window report for this engine's account; absent
   * until a turn or refresh reports one (server keeps it in memory only) */
  rateLimits?: RateLimitReport;
  install?: EngineInstall;
  /** Configured CLI path override - set ONLY when the user overrode it;
   * absent means the driver default is in effect. */
  cli?: string;
  /** Driver's default binary name (e.g. "claude"). */
  cliDefault?: string;
  /** Absolute paths of every default binary found on PATH, PATH order. */
  cliCandidates?: string[];
}

export type AppSettingsSection =
  | "account"
  | "general"
  | "connections"
  | "themes"
  | "shortcuts"
  | "engines"
  | "companion"
  | "computer"
  | "usage"
  | "team"
  | "models-index"
  | "sync";

export interface AppState {
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  /** selected chat - a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "team-map" | "routines" | "skill-recorder";
  /** a bot workspace covers the conversation surface while activeView stays "chat" */
  workspaceOpen: boolean;
  routines: Routine[];
  routineRuns: RoutineRun[];
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  createBotOpen: boolean;
  composerFocusBotId: string | null;
  settingsOpen: boolean;
  /** Bumps when the chat avatar asks bot details to open the avatar picker. */
  settingsAvatarRequest: number;
  /** Bumps when the chat header's keep going mark asks bot details to show that switch. */
  settingsKeepGoingRequest: number;
  pluginsOpen: boolean;
  computerOpen: boolean;
  /** the per-thread event inspector (runtime stream + native protocol tee) */
  inspectorOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  appSettingsPage: boolean;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  /** who is driving each bot's computer: held = the person has the wheel
   * (the bot's hands are refused server-side); helpReason = the bot's open
   * plea for the person to take over */
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  /** a search hit to scroll to once its thread is on screen; nonce lets the
   * same message be focused twice in a row */
  focusMessage: { threadId: string; messageId: string; nonce: number; consumed: boolean; query?: string } | null;
  connected: boolean;
  /** true once the first `hydrate` action has landed and state.bots reflects the real snapshot */
  hydrated: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
  /** 1:1 queue-fallback lines waiting for drain; keyed by threadId.
   * Each entry is identified by the server queueId, not by text. */
  pendingQueued: Record<string, Array<{ queueId: string; text: string; at?: number; sendId?: string; replyToId?: string; reason?: "sync" }>>;
  /** queueIds whose drain frame beat the POST continuation. One-shot and
   * bounded to a short event window so other clients cannot grow it forever. */
  consumedQueueIds: Record<string, true>;
  /** Patches for rows older than every loaded page, keyed by threadId then
   * message id. An older page applies them before it lands. */
  olderPatches: Record<string, Record<string, Message>>;
  /** Snapshots applied so far; a jump window fetched before one is stale. */
  snapshots: number;
  /** Session dismissals for the Continuity strip, keyed by thread. A later
   * crash/stop/shutdown packet with a new updatedAt may show again. */
  dismissedTaskRecovery: Record<string, { updatedAt: number; flushReason: TaskResumePacket["flushReason"] }>;
  /** Sends the composer accepted this tick; Thinking / Sends-next paint
   * from this until POST or SSE confirms, so chrome does not wait on
   * startTurn's prepareModelContext waterfall. */
  acceptedSends: AcceptedSends;
  /** Bots the user just stopped, held idle until the server says so. Busy
   * frames already on the wire would otherwise flash Stop back. */
  stoppingBots: Record<string, StopHold>;
  /** Renderer-only PTY alerts, separate from durable chat unread state. */
  terminalAttention: TerminalAttentionMap;
  /** Labels of each bot's open worker panes, from the desktop terminal host. */
  terminalPanes: Record<string, string[]>;
  /** Latest task switch request per bot; an older response is dropped. */
  taskSwitches: Record<string, number>;
  /** Task switch generation each bot's last branch choice followed; its snapshot keeps that leaf. */
  branchChoices: Record<string, number>;
}

type StopHold = { until: number; busy: boolean; activity?: Bot["activity"] };

interface QueueReceiptSnapshot {
  messages?: Message[];
}

export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

export type Action =
  | {
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      computerControl: Record<string, { held: boolean; helpReason: string | null }>;
      sidebarOrder: SidebarOrder;
    }
  | { type: "olderMessages"; threadId: string; before: string; messages: Message[]; hasMore: boolean }
  | { type: "showRoutines" }
  | { type: "showTeamMap" }
  | { type: "showSkillRecorder" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | {
      type: "createGroup";
      memberIds: string[];
      name?: string;
      section?: string;
      /** Wizard path: completed setup skips the old setup screen. */
      setup?: { bulletin: string; defaultResponder: GroupDefaultResponder };
      onSuccess?: (group: Group) => void;
      onError?: () => void;
    }
  | {
      type: "sendGroup";
      groupId: string;
      text: string;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      onError?: () => void;
    }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "newGroupTask"; groupId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "renameGroupTask"; groupId: string; threadId: string; title: string }
  | { type: "deleteGroupTask"; groupId: string; threadId: string }
  | { type: "toggleReaction"; threadId: string; messageId: string; emoji: string; message?: Message }
  | { type: "interruptGroup"; groupId: string }
  | { type: "instances"; instances: InstanceInfo[]; preserveRateLimits?: boolean }
  | { type: "rateLimits"; instanceId: string; report: RateLimitReport }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | {
      type: "send";
      botId: string;
      text: string;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      /** Wait for the running turn instead of steering into it. */
      after?: boolean;
      queueId?: string;
      onError?: () => void;
    }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string; at?: number; sendId?: string; replyToId?: string; reason?: "sync" }
  | { type: "sendQueuedNow"; botId: string; threadId: string; queueId: string }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; threadId: string; queueId: string }
  | { type: "sendSettled"; threadId: string; sendId: string; queued?: boolean }
  | { type: "sendRejected"; threadId: string; sendId: string; botId?: string }
  | { type: "editMessage"; botId: string; messageId: string; text: string; expectedSelection?: ModelSelection; onSettled?: (error?: unknown) => void }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  /** rooms: a member's ask_user question, answered by a room message */
  | { type: "answerGroupCard"; groupId: string; messageId: string; answer: string }
  | { type: "dismissGroupCard"; groupId: string; messageId: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** remember this exact grant (the server's allowKey) for the bot */
      alwaysAllow?: { botId: string; key: string };
      /** Local UI recovery hook for voice flows. Never sent to the server. */
      onError?: (message: string) => void;
    }
  | { type: "switchTask"; botId: string; threadId: string; generation?: number }
  | { type: "notificationSwitchPending"; target: NotificationTarget }
  | { type: "taskSwitched"; bot: Bot; generation?: number }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "taskPacket"; threadId: string; packet: TaskResumePacket }
  | { type: "resumeTask"; botId: string; threadId: string; onSettled?: (error: string | null, pending?: boolean) => void }
  | {
      type: "dismissTaskRecovery";
      botId: string;
      threadId: string;
      updatedAt: number;
      flushReason: TaskResumePacket["flushReason"];
    }
  | { type: "newBot" }
  | { type: "closeCreateBot" }
  | { type: "botAdded"; bot: Bot; focusComposer?: boolean; activate?: boolean }
  | { type: "composerFocused"; botId: string }
  | { type: "deleteBot"; botId: string }
  | { type: "reorderBots"; botIds: string[] }
  | { type: "reorderGroups"; groupIds: string[] }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | {
      type: "markTerminalAttention";
      botId: string;
      sessionId: string;
      reason: TerminalAttentionReason;
      receivedAt: number;
    }
  | { type: "ackTerminalAttention"; botId: string; sessionId: string }
  | { type: "setTerminalPanes"; panes: Record<string, string[]> }
  | { type: "setBotTerminalPanes"; botId: string; labels: string[] }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "setModel"; botId: string; selection: ModelSelection; holdForSwitch?: boolean; onApplied?: (bot: Bot) => void; onFailure?: () => void }
  | { type: "interrupt"; botId: string; until?: number; onSettled?: () => void; switchThreadId?: string; onStopped?: (result: { stopped: boolean; returned: unknown[] }) => void; onFailure?: () => void }
  | { type: "stopReleased"; botId: string; until: number }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean; avatar?: boolean; keepGoing?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "setWorkspaceOpen"; open: boolean }
  | { type: "windowActivated" }
  | { type: "focusMessage"; threadId: string; messageId: string; query?: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "mascotMotionDone"; nonce: number }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
}

interface NotificationRoutingState {
  bots: NotificationThreadOwner[];
  groups: NotificationThreadOwner[];
}

export interface PeripheralSnapshotLoad<Key extends string = string> {
  key: Key;
  load: () => Promise<void>;
}

type PendingDeltas = StreamBuffers & { tail: string; ramps?: StreamRamp[] };

export type { StopHold, QueueReceiptSnapshot, NotificationRoutingState, PendingDeltas };
