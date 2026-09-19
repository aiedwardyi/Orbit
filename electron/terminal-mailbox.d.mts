export function mailboxGrant(token: string, pane: string, bot: string, teacher: string): string;
export function terminalPaneEnv(
  base: Record<string, string | undefined>,
  pane: { pane: string; bot: string; teacher?: string; mailbox?: { url: string; token: string; binDir: string | null } | null },
): Record<string, string | undefined>;
export function installOrbitMsg(dir: string, platform?: NodeJS.Platform): Promise<string | null>;
