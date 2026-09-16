import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applySkin, readSkin } from "./lib/skins";
import { applyGeometry, readGeometry } from "./lib/geometry";
import { applyLocale, readOsLocaleTag, readPreference, resolveLocale } from "./lib/i18n";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());
applyGeometry(readGeometry());
applyLocale(resolveLocale(readPreference(), readOsLocaleTag()));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
