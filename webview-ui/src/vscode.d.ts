/**
 * VSCode Webview API global typings.
 */

interface VSCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare function acquireVsCodeApi(): VSCodeApi;
