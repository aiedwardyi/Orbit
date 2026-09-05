/** Selected conversation gets the only strong row fill. Chief is a badge,
 * not a second selected-looking wash — otherwise Skye-as-Chief steals
 * emphasis from the Nova row that is actually open. */
export function sidebarConversationRowTone(selected: boolean): string {
  return selected
    ? "border-transparent bg-raised"
    : "border-transparent hover:bg-raised/50";
}
