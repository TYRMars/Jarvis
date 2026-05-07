// Image upload adapter contract — mirror of spec §5
// `ImageUploadAdapter`. The editor never reads files into base64;
// every successful upload returns a stable URL the renderer points
// at. Concrete adapters live outside this module (the demo mock,
// the future server-backed adapter, etc.).

export interface ImageUploadResult {
  url: string;
  width?: number;
  height?: number;
}

export interface ImageUploadAdapter {
  upload(file: File): Promise<ImageUploadResult>;
}

/** Mock adapter for the playground / dev mode. Returns a blob URL
 *  after a short delay, with optional injected failure so the UI's
 *  error path can be exercised without a real backend. */
export interface MockAdapterOptions {
  /** Failure rate (0-1). Default 0. */
  failureRate?: number;
  /** Artificial delay in ms. Default 800. */
  delayMs?: number;
}

export function createMockUploadAdapter(opts: MockAdapterOptions = {}): ImageUploadAdapter {
  const { failureRate = 0, delayMs = 800 } = opts;
  return {
    async upload(file: File) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (Math.random() < failureRate) {
        throw new Error("mock upload failure");
      }
      return { url: URL.createObjectURL(file) };
    },
  };
}
