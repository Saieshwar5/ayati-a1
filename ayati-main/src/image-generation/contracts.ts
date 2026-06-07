export interface ImageGenerationInput {
  prompt: string;
  size?: string;
  quality?: string;
  outputFormat?: "png" | "jpeg" | "webp";
}

export interface ImageGenerationOutput {
  model: string;
  mimeType: string;
  base64: string;
}

export interface ImageGenerationProvider {
  readonly name: string;
  readonly modelName: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
}
