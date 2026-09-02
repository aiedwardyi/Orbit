/** Packaged Windows hides and does not start Phone/companion. The feature is
 * parked, not deleted: unpackaged Windows and other packaged platforms keep it. */
export function companionParkedOnDesktop({ platform, packaged } = {}) {
  return packaged === true && platform === "win32";
}
