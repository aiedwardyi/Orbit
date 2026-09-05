/** Shared 1:1 + room transcript/composer column. Caps ultrawide panes at a
 * readable width without changing bubble or composer content.
 *
 * Apply to the transcript stack *and* the composer dock. Put `px-5` on the
 * transcript stack (and RoomSetup), not the scroll scroller — Composer
 * already has `px-5`, so a padded scroller would make the two 960 boxes
 * unequal. The in-flow transcript keeps its own `w-full`; the absolute dock
 * centers via `inset-x-0` + `max-w-[960px]` + `mx-auto`. */
export const CHAT_COLUMN_CLASS = "mx-auto max-w-[960px]";
