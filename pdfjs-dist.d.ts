declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const VerbosityLevel: {
    ERRORS: number;
    WARNINGS: number;
    INFOS: number;
  };

  export function getDocument(src: Record<string, unknown>): {
    promise: Promise<unknown>;
    destroy(): Promise<void> | void;
  };
}

declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
