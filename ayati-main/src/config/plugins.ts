import type { PluginFactory } from "../core/index.js";

const pluginFactories: PluginFactory[] = [
  () => import("../plugins/agentmail/index.js"),
];

export default pluginFactories;
