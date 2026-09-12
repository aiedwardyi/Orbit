import { appendFileSync, readFileSync } from "node:fs";

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("api.anthropic.com/api/oauth/usage")) {
    if (process.env.FAKE_USAGE_REPORTS) {
      const token = new Headers(init?.headers).get("authorization");
      const reports = JSON.parse(readFileSync(process.env.FAKE_USAGE_REPORTS, "utf8"));
      if (process.env.FAKE_USAGE_CALLS) appendFileSync(process.env.FAKE_USAGE_CALLS, `${token}\n`);
      return Response.json({ five_hour: null, seven_day: { utilization: reports[token], resets_at: null } });
    }
    return Response.json({
      five_hour: { utilization: 42, resets_at: "2026-10-01T12:00:00.000Z" },
      seven_day: { utilization: 19, resets_at: "2026-10-01T12:00:00.000Z" },
    });
  }
  return originalFetch(input, init);
};
