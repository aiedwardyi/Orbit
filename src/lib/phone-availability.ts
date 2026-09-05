/** Phone/companion is parked on packaged desktops until Orbit hosts its own
 * control plane. Unpackaged development builds keep the Settings entry so
 * local pairing can still be exercised. */
export function phoneSettingsAvailable(host: {
  platform?: string;
  packaged?: boolean;
}): boolean {
  return host.packaged !== true;
}
