import { createRoot } from "react-dom/client";
import { App } from "./App";

const savedTheme = localStorage.getItem("jarvis.theme");
const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = savedTheme || (systemDark ? "dark" : "light");

createRoot(document.getElementById("root")!).render(<App />);
