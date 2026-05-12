import dotenv from "dotenv";
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

dotenv.config();

const execFileAsync = promisify(execFile);

const BridgeEnvSchema = z.object({
  CURSOR_BRIDGE_PORT: z.coerce.number().int().positive().default(8787),
  CURSOR_BRIDGE_HOST: z.string().default("127.0.0.1"),
  CURSOR_BRIDGE_AUTH_TOKEN: z.string().optional(),
  CURSOR_BRIDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  CURSOR_BRIDGE_CWD: z.string().optional(),
  CURSOR_AGENT_BIN: z.string().default("cursor"),
  CURSOR_AGENT_MODE: z.enum(["ask", "plan"]).default("ask")
});

const parsedEnv = BridgeEnvSchema.safeParse(process.env);
if (!parsedEnv.success) {
  const details = parsedEnv.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
  throw new Error(`Invalid bridge environment configuration: ${details}`);
}
const bridgeEnv = parsedEnv.data;

const InferRequestSchema = z.object({
  prompt: z.string().min(1),
  modelId: z.string().min(1),
  timeoutMs: z.coerce.number().int().positive().max(300000).optional()
});

const app = express();
app.use(express.json({ limit: "2mb" }));

function compactErrorText(stderr: string, fallback: string): string {
  const text = stderr.trim();
  if (!text) {
    return fallback;
  }
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return fallback;
  }
  return lines.slice(-2).join(" | ");
}

function isAuthorized(req: express.Request): boolean {
  if (!bridgeEnv.CURSOR_BRIDGE_AUTH_TOKEN) {
    return true;
  }
  return req.get("x-bridge-token") === bridgeEnv.CURSOR_BRIDGE_AUTH_TOKEN;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "cursor_bridge",
    host: bridgeEnv.CURSOR_BRIDGE_HOST,
    port: bridgeEnv.CURSOR_BRIDGE_PORT
  });
});

app.post("/infer", async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized bridge request", code: "unauthorized" });
    return;
  }

  const parsed = InferRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
    res.status(400).json({ ok: false, error: details, code: "invalid_request" });
    return;
  }

  const timeoutMs = parsed.data.timeoutMs ?? bridgeEnv.CURSOR_BRIDGE_TIMEOUT_MS;
  const cwd = bridgeEnv.CURSOR_BRIDGE_CWD ?? process.cwd();
  const commandArgs = [
    "agent",
    "--print",
    "--output-format",
    "text",
    "--mode",
    bridgeEnv.CURSOR_AGENT_MODE,
    "--trust",
    "--workspace",
    cwd,
    "--model",
    parsed.data.modelId,
    parsed.data.prompt
  ];

  try {
    const startedAt = Date.now();
    const { stdout } = await execFileAsync(bridgeEnv.CURSOR_AGENT_BIN, commandArgs, {
      cwd,
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    const result = stdout.trim();
    if (!result) {
      res.status(502).json({ ok: false, error: "empty cursor-agent output", code: "empty_output" });
      return;
    }
    res.json({
      ok: true,
      status: "finished",
      result,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "cursor-agent execution failed";
    const typedError = error as { stderr?: unknown; code?: unknown };
    const stderr = typeof typedError.stderr === "string" ? typedError.stderr : "";
    const code = typeof typedError.code === "string" ? typedError.code : "cursor_agent_exec_error";
    res.status(502).json({
      ok: false,
      error: compactErrorText(stderr, message),
      code
    });
  }
});

app.listen(bridgeEnv.CURSOR_BRIDGE_PORT, bridgeEnv.CURSOR_BRIDGE_HOST, () => {
  console.log(
    `cursor bridge running on http://${bridgeEnv.CURSOR_BRIDGE_HOST}:${bridgeEnv.CURSOR_BRIDGE_PORT}`
  );
});
