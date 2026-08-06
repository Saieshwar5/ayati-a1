#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app/app.js";
import { createMouseTrackingStdin } from "./app/input/terminal-mouse.js";
import { runVoiceCommand } from "./voice/voice-control-client.js";

const args = process.argv.slice(2);
if (args[0] === "voice") {
  process.exitCode = await runVoiceCommand(args.slice(1));
} else {
  const mouseScrollEnabled = process.env["AYATI_MOUSE_SCROLL"] === "1";
  const stdin = mouseScrollEnabled
    ? createMouseTrackingStdin(process.stdin)
    : process.stdin;

  render(<App />, { stdin: stdin as unknown as NodeJS.ReadStream });
}
