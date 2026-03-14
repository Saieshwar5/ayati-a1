import type { ProviderFactory } from "../core/index.js";

const providerFactory: ProviderFactory = () => import("../providers/runtime/index.js");

export default providerFactory;
