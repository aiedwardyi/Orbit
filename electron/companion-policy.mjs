/** Packaged desktops hide and do not start Phone/companion. The feature is
 * parked, not deleted: unpackaged development builds can still exercise it. */
export function companionParkedOnDesktop({ packaged } = {}) {
  return packaged === true;
}
