import OpenAI from "openai";
import { getImageGenerationModelForProvider } from "../../config/llm-runtime-config.js";
import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProvider,
} from "../contracts.js";

let client: OpenAI | null = null;

const provider: ImageGenerationProvider = {
  name: "openai",

  get modelName() {
    return getImageGenerationModelForProvider("openai");
  },

  start() {
    const apiKey = process.env["OPENAI_API_KEY"]?.trim();
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable for image generation.");
    }

    client = new OpenAI({ apiKey });
  },

  stop() {
    client = null;
  },

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    if (!client) {
      throw new Error("OpenAI image generation provider not started.");
    }

    const response = await client.images.generate({
      model: this.modelName,
      prompt: input.prompt,
      ...(input.size ? { size: input.size as any } : {}),
      ...(input.quality ? { quality: input.quality as any } : {}),
      ...(input.outputFormat ? { output_format: input.outputFormat as any } : {}),
    } as any);

    const image = response.data?.[0];
    if (!image?.b64_json) {
      throw new Error("Empty response from OpenAI image generation.");
    }

    return {
      model: this.modelName,
      mimeType: mimeTypeForOutputFormat(input.outputFormat),
      base64: image.b64_json,
    };
  },
};

export default provider;

function mimeTypeForOutputFormat(outputFormat: ImageGenerationInput["outputFormat"]): string {
  switch (outputFormat) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}
