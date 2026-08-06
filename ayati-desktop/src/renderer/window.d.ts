import type { AyatiDesktopApi } from "../shared/contracts.js";

declare global {
  interface Window {
    ayati: AyatiDesktopApi;
  }
}

export {};
