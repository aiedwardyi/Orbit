/** Phone/companion is parked on packaged Windows until Orbit hosts its own
 * control plane. Unpackaged Windows (dev) and other packaged platforms keep
 * the Settings entry so local pairing can still be exercised. */
export function phoneSettingsAvailable(host: {
  platform?: string;
  packaged?: boolean;
}): boolean {
  return !(host.packaged === true && host.platform === "win32");
}
