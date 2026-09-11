const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("api.anthropic.com/api/oauth/usage")) {
    return Response.json({
      five_hour: { utilization: 42, resets_at: "2026-10-01T12:00:00.000Z" },
      seven_day: { utilization: 19, resets_at: "2026-10-01T12:00:00.000Z" },
    });
  }
  return originalFetch(input, init);
};
