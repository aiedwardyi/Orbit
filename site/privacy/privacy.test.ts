import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY =
  "Wink privacy policy Updated October 12, 2026 Wink is a free, open-source app that runs AI bots on your own PCs. This page explains what it does with your data, including data from your Google Account. Your data stays yours Your chats, bot memory and settings are stored on your own PCs. If you turn on sync, Wink copies them to your own Google Drive so your other PCs can read them. When you talk to a bot, your messages go to the AI service you chose for it, under that service's terms. Google user data Signing in with Google gives Wink your Google account ID and email address, and access only to the Drive files Wink itself creates. Wink can't see any other files in your Drive. Wink uses your account ID and email only to tell which PCs and phones are yours. Wink's relay, which connects your phone to your PC, keeps a list of your PCs that are online, under a hashed account ID, only while they're connected. Its logs keep the hashed ID and part of your IP address for 7 days. It forwards encrypted traffic and can't read your chats. The relay keeps, for 90 days, when each invited PC and its phones connect and disconnect, visible only to the relay's owner. It never records what anyone types. Wink doesn't sell your data, show ads, or share Google user data with anyone. Wink's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Stopping and deleting Sign out in Wink under Settings, Sync to stop syncing. You can delete Wink's files from your Drive at any time, and remove Wink's access at myaccount.google.com/permissions. Questions Open an issue at github.com/aiedwardyi/Orbit.";

function visibleText(html: string): string {
  const body = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
  return body
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("privacy policy page", () => {
  it("is a script-free page with the Limited Use link", () => {
    const privacy = readFileSync(join(ROOT, "site/privacy/index.html"), "utf8");
    expect(privacy).not.toContain("<script");
    expect(privacy).toContain(
      "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
    expect(privacy).toContain('href="https://developers.google.com/terms/api-services-user-data-policy"');
    expect(privacy).toContain("Limited Use");
    expect(visibleText(privacy)).toBe(POLICY);
  });
});
