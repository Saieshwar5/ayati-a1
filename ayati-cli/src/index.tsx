#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app/app.js";
import { createMouseTrackingStdin } from "./app/input/terminal-mouse.js";

const mouseScrollEnabled = process.env["AYATI_MOUSE_SCROLL"] === "1";
const stdin = mouseScrollEnabled
  ? createMouseTrackingStdin(process.stdin)
  : process.stdin;

render(<App />, { stdin: stdin as unknown as NodeJS.ReadStream });
