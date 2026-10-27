import type { Extension } from "mdast-util-from-markdown";

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

// CommonMark reads "\." in a link target as an escaped ".", so "C:\Users\me\.orbit"
// became "C:\Users\me.orbit"; a Windows path keeps the target exactly as written.
export const windowsPathLinks: Extension = {
  exit: {
    resourceDestination(token) {
      const target = this.sliceSerialize(token).replace(/^<(.*)>$/, "$1");
      const node = this.stack.at(-1);
      if (node?.type === "link" && WINDOWS_PATH.test(target)) node.url = target;
    },
  },
};
