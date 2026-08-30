# Orbit external QA prompt

Test the Windows desktop app at `C:\Users\mredw\Desktop\Orbit\release\Orbit-1.0.0-setup.exe` as an independent release candidate.

- Use a clean temporary workspace and do not modify unrelated Desktop files.
- Verify install, first launch, onboarding, relaunch persistence, and uninstall.
- Create a bot, attach a file, send a prompt, stop a turn, and inspect approvals.
- Switch among every installed Grok, Claude, Codex, and Gemini engine.
- For Gemini, verify the Antigravity subscription route and the optional API key control in Settings.
- Exercise empty input, rapid clicks, offline errors, long text, search, settings, and window resizing.
- Do not expose, copy, log, or request any credential value.
- Report each issue with severity, exact steps, expected result, actual result, screenshot, and relevant redacted logs.
- Finish with a release verdict: PASS, PASS WITH NOTES, or BLOCK.

Do not edit the source. Return only the QA report.
