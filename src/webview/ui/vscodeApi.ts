import type { WebviewToExtensionMessage } from '../../types/messages';

export interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** `acquireVsCodeApi` may only be called once per webview; each bundle (editor, sidebar) imports this once. */
export const vscode: VsCodeApi = acquireVsCodeApi();
