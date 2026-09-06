import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { teamImportPreview } from "./team-import";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "../components/TeamLibraryPanel.tsx"), "utf8");

describe("team import preview", () => {
  it.each([1, 2])("previews version %s team files", (version) => {
    const preview = teamImportPreview({
      format: "openmaus.team",
      version,
      team: {
        name: " Engineering ",
        description: " Ships software ",
        members: [{ name: " Ada ", title: " Tech Lead " }],
        ...(version === 1
          ? { room: { name: "Engineering", bulletin: "", defaultResponder: { kind: "everyone" } } }
          : {}),
      },
    });

    expect(preview).toMatchObject({
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it("rejects unsupported and empty files", () => {
    expect(() => teamImportPreview({ format: "openmaus.team", version: 3, team: {} })).toThrow("not supported");
    expect(() =>
      teamImportPreview({ format: "openmaus.team", version: 2, team: { name: "Empty", members: [] } }),
    ).toThrow("no members");
  });

  it("previews the complete package setup before installation", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Lead Desk",
        summary: "Find qualified conversations.",
        agents: [
          { key: "scout", name: "Scout", title: "Researcher" },
          { key: "writer", name: "Writer", title: "Outreach" },
        ],
        chiefOfStaff: "scout",
        rooms: [{}],
        playbooks: [{}, {}],
        routines: [{}],
        requirements: {
          apps: [
            { label: "Reddit" },
            { label: "Google Sheets", optional: true },
          ],
        },
      },
    });

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      rooms: 1,
      playbooks: 2,
      routines: 1,
      apps: [
        { label: "Reddit", optional: false },
        { label: "Google Sheets", optional: true },
      ],
    });
  });

  it("previews a portable Markdown playbook", () => {
    const preview = teamImportPreview(`---
botmrr: 1
name: Lead Desk
summary: Find qualified conversations.
agents:
  - key: scout
    name: Scout
    title: Researcher
chiefOfStaff: scout
rooms: []
playbooks: []
routines: []
requirements:
  apps:
    - label: Reddit
---

# Lead Desk

## Activation

Create the team.`);

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      apps: [{ label: "Reddit", optional: false }],
    });
  });

  it("keeps user-facing copy free of BotMRR and .mausteam.json", () => {
    expect(() => teamImportPreview({ format: "nope" })).toThrow(
      "This is not an Orbit playbook or a team file.",
    );
    expect(() => teamImportPreview("plain text")).toThrow(
      "This Markdown is missing its playbook frontmatter.",
    );
    expect(() => teamImportPreview("---\n[]\n---\n")).toThrow(
      "This Markdown is missing its playbook blueprint.",
    );
    expect(() => teamImportPreview("---\nbotmrr: 9\nname: x\n---\n")).toThrow(
      "This playbook Markdown version is not supported.",
    );
    expect(() => teamImportPreview({ format: "openmaus.package", version: 2, package: {} })).toThrow(
      "Playbook version 2 is not supported.",
    );

    expect(panel).toContain("or drop a playbook .md / legacy team JSON here");
    expect(panel).not.toContain("BotMRR");
    expect(panel).not.toContain(".mausteam.json");
  });
});
