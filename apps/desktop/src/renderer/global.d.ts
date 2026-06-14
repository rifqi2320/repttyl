import type { RepttylDesktopAPI } from "../preload";

declare global {
  interface Window {
    repttyl: RepttylDesktopAPI;
  }
}

export {};
