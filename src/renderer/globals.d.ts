export {};

declare global {
  interface Window {
    electronAPI: any;
    __aiHubHideOpenClawUpdate?: MutationObserver;
  }

  interface Document {
    getElementById(elementId: string): any;
  }

  interface ParentNode {
    querySelector(selectors: string): any;
    querySelectorAll(selectors: string): any[];
  }
}
