/** Chromium gives up on a busy Windows clipboard after about 25 ms, so a paste
 * can reach the page as a 0-byte image. Retry until the holder lets go. */
const RETRY_MS = [100, 200, 400];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readClipboardImage(clipboard, wait = sleep) {
  for (const delay of [0, ...RETRY_MS]) {
    if (delay) await wait(delay);
    const image = clipboard.readImage();
    if (!image.isEmpty()) return image.toPNG();
  }
  return null;
}
