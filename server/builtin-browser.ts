import { builtInBrowserEnabled, type AppConfig } from "./config.ts";

/** The one gate for handing a bot the browser tools (removed, so always off); the prompt follows the mount. */
export function botBrowserEnabled(cfg: AppConfig, bot: { browser?: boolean }, capabilities: { browserMcp?: boolean }): boolean {
  return builtInBrowserEnabled(cfg) && bot.browser !== false && capabilities.browserMcp === true;
}

const BROWSER_PROMPT =
  " You have your own built-in web browser through the browser tools: browser_navigate opens a page and browser_snapshot returns its accessibility tree with [ref=eN] refs; browser_click, browser_fill, browser_select_option, browser_hover and browser_press act on refs; browser_read returns the page's text; browser_wait_for waits for text or an address; browser_screenshot shows the page when the tree isn't enough. Every browser action already returns the resulting page, so don't follow it with browser_snapshot. The user watches the same page in the Browser panel and can take over at any time. At a sign-in, password, MFA, CAPTCHA, or payment step, call browser_request_takeover with what you need and continue from the page it returns; never type their password or a one-time code.";

export function browserPrompt(mounted: boolean): string {
  return mounted ? BROWSER_PROMPT : "";
}
