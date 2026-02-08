import type { ProviderFactory } from "../core/index.js";

const providerFactory: ProviderFactory = () => import("../providers/openai/index.js");

export default providerFactory;
