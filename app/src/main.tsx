// First, and deliberately: the Solana surface reads `Buffer` at module scope. See the file header.
import "./bufferGlobal.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
