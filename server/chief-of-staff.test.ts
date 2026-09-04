import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt, peerAgentsSystemPrompt } from "./chief-of-staff.ts";

// Two describe blocks below assert on index.ts SOURCE rather than behaviour.
// runClaimedGroupMemberTurn and automaticRequirements are both private, and the
// properties worth pinning are structural: the room path passes the room flag,
// and the Chief flag never gates engine selection. Same idiom as i18n.test.ts.
// Moving this file, splitting index.ts, or adding an inline `function` helper
// inside runClaimedGroupMemberTurn will break the slicing, not the behaviour.
const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, "index.ts"), "utf8");

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    // an imported 10KB description must not ride into the Chief's system
    // prompt — the roster line stays bounded
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates, roles, and availability", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("Chief of Staff for the Work section");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy (available)");
    expect(prompt).toContain("Patch — Engineer (working right now)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).not.toContain("Scout");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("Use ask_bot");
    expect(prompt).toContain("use create_bot");
    expect(prompt).toContain("create_channel");
    expect(prompt).toMatch(/Never scan the environment, ports, or processes/);
    expect(prompt).toMatch(/never invent localhost APIs/i);
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("Use ask_bot");
  });

  it("does not tell a solo Chief to scan the roster or spawn bots unasked", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Clover", section: "Work" }], true);

    expect(prompt).toContain("Chief of Staff for the Work section");
    expect(prompt).toMatch(/Answer the user directly/i);
    expect(prompt).not.toMatch(/list_bots/);
    expect(prompt).not.toContain("No other visible bots are available yet.");
    // tools stay unnamed for idle turns, but a two-bot-channel ask must have
    // a named path — otherwise the Chief greps the repo and probes :8799
    expect(prompt).toMatch(/If they ask[\s\S]*create_bot/);
    expect(prompt).toContain("create_channel");
    expect(prompt).toMatch(/Never scan the environment, ports, or processes/);
    expect(prompt).toMatch(/never invent localhost APIs/i);
  });

  it("tells an in-room Chief to spawn directly instead of probing the machine", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true, "", true);

    expect(prompt).toContain("shared room");
    expect(prompt).toContain("call create_bot directly");
    expect(prompt).toContain("joins this section, not this room");
    expect(prompt).toContain("create_channel");
    // delegate_bot cannot report back inside this turn; ask_bot is the one that waits
    // the hasTeam delegation paragraph above still says "then use delegate_bot",
    // and create_bot's tool result names it too, so the room override has to
    // supersede both by name, not just tool results
    expect(prompt).toContain("Use ask_bot rather than delegate_bot");
    expect(prompt).toContain("including when the delegation guidance above or a tool result says otherwise");
    expect(prompt).toMatch(/Never scan the environment, ports, or processes/);
  });

  it("keeps 1:1 prompts free of the room framing", () => {
    const roomPrompt = chiefOfStaffSystemPrompt("chief", bots, true, "", true);
    const directPrompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(directPrompt).not.toContain("shared room");
    expect(directPrompt).toMatch(/Never scan the environment/);
    // the property is "1:1 loses nothing, the room gains framing", not a line
    // count: roomDiscipline joins with spaces today but must be free to change
    const direct = directPrompt.split("\n");
    const extra = roomPrompt.split("\n").filter((line) => !direct.includes(line));
    expect(direct.every((line) => roomPrompt.includes(line))).toBe(true);
    expect(extra.join(" ")).toContain("shared room");
  });

  it("does not mount room discipline on an engine that cannot delegate", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false, "", true);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("shared room");
    expect(prompt).not.toContain("create_bot");
  });

  it("keeps the solo-Chief idle wall shut in a room but names the asked path", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Clover", section: "Work" }], true, "", true);

    expect(prompt).toMatch(/Answer the user directly/i);
    expect(prompt).toContain("shared room");
    expect(prompt).not.toMatch(/list_bots/);
    expect(prompt).toMatch(/If they ask[\s\S]*create_bot/);
    expect(prompt).toContain("create_channel");
  });

  it("tells any agents-tool bot to create a channel instead of probing localhost", () => {
    const prompt = peerAgentsSystemPrompt();

    expect(prompt).toContain("list_bots");
    expect(prompt).toContain("ask_bot");
    expect(prompt).toContain("create_channel");
    expect(prompt).toMatch(/Never scan the environment, ports, or processes/);
    expect(prompt).toMatch(/never invent localhost APIs/i);
    expect(prompt).not.toContain("create_bot");
  });

  it("includes trusted OpenMaus status only when the Chief caller supplies it", () => {
    const status = "TRUSTED OPENMAUSBOT STATUS\nfreshness=fresh; runtime_state=degraded";

    const chiefPrompt = chiefOfStaffSystemPrompt("chief", bots, true, status);
    const ordinaryPrompt = chiefOfStaffSystemPrompt("writer", bots, true);

    expect(chiefPrompt).toContain(status);
    expect(ordinaryPrompt).not.toContain("TRUSTED OPENMAUSBOT STATUS");
  });
});

describe("room turns mount the Chief framing", () => {
  it("builds the Chief prompt for a room and emits it into the room system block", () => {
    // the tools were always mounted in rooms; only the framing was missing,
    // so the guard is that BOTH turn kinds now build this prompt
    // scoped to the room turn on purpose: the 1:1 site declares an identically
    // named coordinationPrompt, so a file-wide search proves nothing here. The
    // slice stops at the next top-level function so later code cannot satisfy
    // these assertions on the room path's behalf.
    const start = index.indexOf("async function runClaimedGroupMemberTurn");
    const nextFn = index.slice(start + 1).search(/\n(?:async )?function [a-zA-Z]/);
    const roomTurn = index.slice(start, nextFn === -1 ? undefined : start + 1 + nextFn);
    expect(roomTurn).not.toContain("function startGroupTurn");
    expect(roomTurn).toContain("    coordinationPrompt,");
    // the room flag is the whole fix: without it the room silently falls back
    // to the 1:1 framing and every other assertion here still passes
    expect(roomTurn).toMatch(
      /coordinationPrompt = bot\.chiefOfStaff[\s\S]*?openMausStatusSystemPrompt\(\),\s*true,/,
    );
  });
});

describe("1:1 turns mount the agents-tool channel path", () => {
  it("uses the shared peer-agents prompt instead of an inline tool list", () => {
    const start = index.indexOf("const tagged = integrations.agents");
    const slice = index.slice(start, start + 2500);
    expect(slice).toContain("peerAgentsSystemPrompt()");
    expect(slice).not.toContain("You can work with the other bots in your section through the agents tools");
  });
});

describe("the Chief role does not gate engine selection", () => {
  it("leaves agentsMcp required only by approvePeerComms", () => {
    const start = index.indexOf("function automaticRequirements");
    expect(start).toBeGreaterThan(0);
    const body = index.slice(start, start + index.slice(start).indexOf("\n}"));
    // collapse whitespace first: a reformatted multi-line condition must not be
    // able to hide from these assertions
    const normalized = body.replace(/\s+/g, " ");

    // exactly one push, and it must carry the approvePeerComms condition. An
    // added unconditional push fails the count; replacing the conditional one
    // fails the second assertion.
    expect([...normalized.matchAll(/required\.push\("agentsMcp"\)/g)]).toHaveLength(1);
    expect(normalized).toContain('if (bot.approvePeerComms === true) required.push("agentsMcp")');
    // re-tying the Chief flag to agentsMcp strands an automatic-mode bot on a
    // workspace with no capable engine: every turn 409s instead of degrading
    expect(normalized).not.toContain("chiefOfStaff");
  });
});
