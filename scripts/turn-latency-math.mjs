// Pure timing math for the turn-latency baseline: event marks in, one
// decomposed summary out. No I/O, no clock reads — every timestamp arrives
// on the event, so tests drive it with a mocked clock and the runner feeds
// it wall-clock marks. A turn that never emitted keeps nulls, never zeros.

/** One mark on a turn timeline. `t` is ms on a single clock per turn. */
export function summarizeTurn(events) {
  const start = events.find((event) => event.kind === "start");
  const end = events.find((event) => event.kind === "end");
  const firstContent = events.find((event) => event.kind === "firstToken" || event.kind === "tokens");
  const totalMs = start && end ? end.t - start.t : null;

  let outputTokens = 0;
  for (const event of events) {
    if (event.kind === "tokens" && Number.isFinite(event.n)) outputTokens += event.n;
  }
  if (outputTokens === 0 && end && Number.isFinite(end.output)) outputTokens = end.output;

  const ttftMs = start && firstContent ? firstContent.t - start.t : null;
  const streamMs = firstContent && end ? end.t - firstContent.t : null;
  const tokPerSec = outputTokens > 0 && streamMs !== null && streamMs > 0 ? outputTokens / (streamMs / 1000) : null;

  const toolTrips = [];
  const openTools = [];
  for (const event of events) {
    if (event.kind === "toolStart") openTools.push(event.t);
    else if (event.kind === "toolEnd" && openTools.length > 0) toolTrips.push(event.t - openTools.pop());
  }

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
