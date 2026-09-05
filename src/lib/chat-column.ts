/** Shared 1:1 + room transcript/composer column. Caps ultrawide panes at a
 * readable width without changing bubble or composer content.
 *
 * Apply to the transcript stack *and* the composer dock. Put `px-5` on the
 * transcript stack (and RoomSetup), not the scroll scroller — Composer
 * already has `px-5`, so a padded scroller would make the two 960 boxes
 * unequal. `w-full` sizes the in-flow transcript; on the absolute dock,
 * `inset-x-0` + `max-w-[960px]` + `mx-auto` do the centering. */
export const CHAT_COLUMN_CLASS = "mx-auto w-full max-w-[960px]";
