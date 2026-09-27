// Below md the drawer button floats over the leading corner of every page
// header, so its own inset and the room each header leaves for it have to come
// from one place. 14px + the button's 6px padding drops the glyph on the 20px
// `px-5` edge those headers already use, and 44px of reserve is exactly where
// the button's box ends. `top-[15px]` centers the 30px button on the 60px
// leading row the same headers declare below.
//
// Kept as plain literal strings so Tailwind's scanner sees every class.

/** Where the drawer button itself sits. */
export const DRAWER_BUTTON_LEFT = "left-3.5 top-[15px]";
export const DRAWER_BUTTON_RIGHT = "right-3.5 top-[15px]";

/** The leading row a page header keeps clear for it. */
export const DRAWER_HEADER_LEFT = "max-md:min-h-[60px] max-md:pl-11";
export const DRAWER_HEADER_RIGHT = "max-md:min-h-[60px] max-md:pr-11";
