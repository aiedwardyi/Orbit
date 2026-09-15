#!/usr/bin/env node
// Version-probe fixture that answers slowly: stands in for one sluggish
// provider binary while the rest of the fleet is instant. describe() awaits
// every instance, so this one CLI's --version latency blocks any request
// that resolves the default engine — unless the request already names its
// modelSelection, which skips discovery entirely.
//
//   SLOW_VERSION_DELAY_MS   probe latency (default 4000)
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  const delayMs = Number(process.env.SLOW_VERSION_DELAY_MS ?? 4000);
  setTimeout(() => {
    console.log("slow-cli 9.9.9");
  }, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0);
} else {
  console.log("slow-cli 9.9.9");
}
