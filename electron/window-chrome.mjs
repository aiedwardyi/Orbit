/** Show immediately, with custom inset chrome only on macOS. */
export function windowStartupOptions(platform) {
  if (platform === "darwin") {
    return {
      show: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    };
  }
  return { show: true };
}
