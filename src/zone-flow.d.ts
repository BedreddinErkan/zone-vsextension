declare module 'zone/flow' {
  export type FlowProgressUpdate = string | {
    stage?: string;
    [key: string]: unknown;
  };

  export type RunLlmPatchFlowOptions = {
    task: string;
    repoPath: string;
    provider: string;
    userApiKey: string;
    onProgress?: (update: FlowProgressUpdate) => void;
    abortSignal?: AbortSignal;
  };

  export function runLlmPatchFlow(options: RunLlmPatchFlowOptions): Promise<void>;
}
