import type { PetApi } from "../main/preload";

declare global {
  interface Window {
    petAPI: PetApi;
  }
}

export {};
