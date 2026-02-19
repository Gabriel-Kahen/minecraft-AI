import { GoogleAuth } from "google-auth-library";

export interface GeminiUsage {
  tokensIn?: number;
  tokensOut?: number;
}

export interface GeminiCompletion {
  text: string;
  usage: GeminiUsage;
}

export class VertexGeminiClient {
  private readonly projectId: string;

  private readonly location: string;

  private readonly model: string;

  private readonly auth: GoogleAuth;

  constructor(projectId: string, location: string, model: string) {
    this.projectId = projectId;
    this.location = location;
    this.model = model;
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
  }

  get modelName(): string {
    return this.model;
  }

  async generateJson(prompt: string, timeoutMs: number): Promise<GeminiCompletion> {
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${this.model}:generateContent`;
    const client = await this.auth.getClient();

    const response = await client.request({
      url: endpoint,
      method: "POST",
      timeout: timeoutMs,
      data: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      }
    });

    const data = response.data as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
          }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("vertex response did not contain candidate text");
    }

    return {
      text,
      usage: {
        tokensIn: data.usageMetadata?.promptTokenCount,
        tokensOut: data.usageMetadata?.candidatesTokenCount
      }
    };
  }
}
