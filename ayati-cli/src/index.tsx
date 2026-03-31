#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { App } from "./app/app.js";
import { createMouseTrackingStdin } from "./app/input/terminal-mouse.js";

const stdin = createMouseTrackingStdin(process.stdin);

render(<App />, { stdin: stdin as unknown as NodeJS.ReadStream });
