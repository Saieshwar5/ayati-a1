import type { AyatiPlugin } from "../../core/contracts/plugin.js";

const plugin: AyatiPlugin = {
  name: "my-module",       // TODO: change this
  version: "1.0.0",

  start() {
    // setup logic here
  },

  stop() {
    // cleanup logic here
  },
};

export default plugin;
