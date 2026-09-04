// Vitest `environment: "happy-dom"` uses Vite's client pipeline, which cannot
// load node:sqlite from server/testing/setup.ts. Keep this file on `node` and
// install a Window on the global before react-dom/client loads.
import { Window as HappyWindow } from "happy-dom";

const happy = new HappyWindow({ url: "http://localhost/" });

function setGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

setGlobal("window", happy);
setGlobal("document", happy.document);
setGlobal("navigator", happy.navigator);
setGlobal("HTMLElement", happy.HTMLElement);
setGlobal("HTMLInputElement", happy.HTMLInputElement);
setGlobal("HTMLButtonElement", happy.HTMLButtonElement);
setGlobal("Element", happy.Element);
setGlobal("Node", happy.Node);
setGlobal("DocumentFragment", happy.DocumentFragment);
setGlobal("Text", happy.Text);
setGlobal("Comment", happy.Comment);
setGlobal("Event", happy.Event);
setGlobal("InputEvent", happy.InputEvent);
setGlobal("FocusEvent", happy.FocusEvent);
setGlobal("MouseEvent", happy.MouseEvent);
setGlobal("KeyboardEvent", happy.KeyboardEvent);
setGlobal("CustomEvent", happy.CustomEvent);
setGlobal("MutationObserver", happy.MutationObserver);
setGlobal("getComputedStyle", happy.getComputedStyle.bind(happy));
setGlobal("requestAnimationFrame", happy.requestAnimationFrame.bind(happy));
setGlobal("cancelAnimationFrame", happy.cancelAnimationFrame.bind(happy));
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
