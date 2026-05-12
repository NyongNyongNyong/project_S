import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CURSOR_BRIDGE_URL: z.string().default("http://127.0.0.1:8787"),
  CURSOR_BRIDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  CURSOR_BRIDGE_AUTH_TOKEN: z.string().optional(),
  STORAGE_ROOT_DIR: z.string().default("content"),
  STORAGE_STORIES_DIR: z.string().default("stories"),
  CURSOR_IDEATION_MODEL: z.string().default("auto"),
  CURSOR_STRUCTURING_MODEL: z.string().default("auto"),
  CURSOR_CONFLICT_MODEL: z.string().default("gemini-3.1-pro"),
  CURSOR_ENABLE_REWRITE: z.coerce.boolean().default(true),
  CURSOR_REWRITE_MODEL: z.string().default("claude-4.6-sonnet-medium-thinking"),
  CHAT_DRAFT_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  CHAT_DEFAULT_EDIT_MODE: z.enum(["preserve", "rewrite"]).default("preserve")
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join(", ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = parsed.data;
