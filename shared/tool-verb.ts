// Codex and ACP name the same calls differently; the header reads the same on every engine.
const VERBS = new Map([
  ["Edit", "Update"],
  ["MultiEdit", "Update"],
  ["edit", "Update"],
  ["fileChange", "Update"],
  ["shell", "Bash"],
  ["commandExecution", "Bash"],
  ["WebFetch", "Fetch"],
  ["WebSearch", "Web Search"],
  ["web_search", "Web Search"],
  ["webSearch", "Web Search"],
  ["Agent", "Task"],
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["grep", "Grep"],
  ["find", "Glob"],
  ["ls", "List"],
  ["run_command", "Bash"],
  ["view_file", "Read"],
  ["write_to_file", "Write"],
  ["replace_file_content", "Update"],
  ["multi_replace_file_content", "Update"],
  ["grep_search", "Grep"],
  ["find_by_name", "Glob"],
  ["list_dir", "List"],
  ["search_web", "Web Search"],
  ["read_url_content", "Fetch"],
]);

export function termVerb(name: string): string {
  const known = VERBS.get(name);
  if (known) return known;
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} - ${mcp[2]} (MCP)`;
  return name;
}
