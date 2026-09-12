import type { TandemiseBridge } from '../shared/bridge.js';

declare global {
  interface Window {
    readonly tandemise: TandemiseBridge;
  }
}

export {};
