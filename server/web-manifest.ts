type WebManifest = {
  icons?: Array<{ purpose?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

export function webManifestForUserAgent(userAgent: string | undefined, manifest: WebManifest): WebManifest {
  if (!userAgent?.includes("SamsungBrowser/") || !manifest.icons) return manifest;
  const icons = manifest.icons.filter((icon) => !icon.purpose?.split(/\s+/).includes("maskable"));
  return icons.length === manifest.icons.length ? manifest : { ...manifest, icons };
}
