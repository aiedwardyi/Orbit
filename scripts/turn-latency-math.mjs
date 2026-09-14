// Pure timing math for the turn-latency baseline: event marks in, one
// decomposed summary out. No I/O, no clock reads — every timestamp arrives
// on the event, so tests drive it with a mocked clock and the runner feeds
// it wall-clock marks. A turn that never emitted keeps nulls, never zeros.

/** One mark on a turn timeline. `t` is ms on a single clock per turn. */
export function summarizeTurn(events) {
  const start = events.find((event) => event.kind === "start");
  const end = events.find((event) => event.kind === "end");
  const firstContent = events.find((event) => event.kind === "firstToken" || event.kind === "tokens");
  // The total spans from the send call, not turn.started, so pre-start costs
  // (spawn, session setup) stay inside the interval the provider subtraction
  // decomposes. Without a send mark it falls back to turn.started.
  const origin = events.find((event) => event.kind === "send") ?? start;
  const totalMs = origin && end ? end.t - origin.t : null;

  let outputTokens = 0;
  for (const event of events) {
    if (event.kind === "tokens" && Number.isFinite(event.n)) outputTokens += event.n;
  }
  if (outputTokens === 0 && end && Number.isFinite(end.output)) outputTokens = end.output;

  const ttftMs = start && firstContent ? firstContent.t - start.t : null;

  // Boundaries pair by item identity so overlapping or FIFO-completing tools
  // cannot steal each other's start. An end without an identity pops the most
  // recent open start (legacy marks); an end whose identity never opened is
  // dropped rather than paired with a stranger.
  const toolTrips = [];
  const openTools = [];
  for (const event of events) {
    if (event.kind === "toolStart") {
      openTools.push({ t: event.t, id: typeof event.itemId === "string" ? event.itemId : undefined });
    } else if (event.kind === "toolEnd") {
      const id = typeof event.itemId === "string" ? event.itemId : undefined;
      let index = -1;
      for (let scan = openTools.length - 1; scan >= 0; scan--) {
        if (id === undefined || openTools[scan].id === id) {
          index = scan;
          break;
        }
      }
      if (index >= 0) toolTrips.push(event.t - openTools.splice(index, 1)[0].t);
    }
  }

  // Throughput is net streaming rate: tool wall time inside the first-token
  // to end window is provider work, not token emission, so it leaves the
  // denominator. A stream fully covered by tool time reports null, not a
  // deflated rate.
  const toolMs = toolTrips.reduce((sum, ms) => sum + ms, 0);
  const streamMs = firstContent && end ? Math.max(0, end.t - firstContent.t - toolMs) : null;
  const tokPerSec = outputTokens > 0 && streamMs !== null && streamMs > 0 ? outputTokens / (streamMs / 1000) : null;

  const localMs = {};
  for (const event of events) {
    if (event.kind === "local" && typeof event.label === "string" && Number.isFinite(event.ms)) {
      localMs[event.label] = (localMs[event.label] ?? 0) + event.ms;
    }
  }
  const localTotal = Object.values(localMs).reduce((sum, ms) => sum + ms, 0);
  const providerMs = totalMs !== null ? totalMs - localTotal : null;

  return { totalMs, ttftMs, outputTokens, tokPerSec, toolTrips, toolCount: toolTrips.length, localMs, providerMs };
}

/** Mean/min/max/population-sd over a sample; nulls when there is no sample. */
export function stats(samples) {
  if (samples.length === 0) return { n: 0, mean: null, min: null, max: null, sd: null };
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return { n: samples.length, mean, min: Math.min(...samples), max: Math.max(...samples), sd: Math.sqrt(variance) };
}
