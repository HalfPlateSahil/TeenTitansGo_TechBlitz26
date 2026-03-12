import { Router } from "express";

import { hasRedisConfig, hasSupabaseConfig } from "../config/env.js";

export const healthRouter = Router();

healthRouter.get("/health", (_request, response) => {
  response.status(200).json({
    ok: true,
    mode: hasSupabaseConfig ? "database" : "memory-bootstrap",
    followUpQueue: hasRedisConfig ? "bullmq" : "in-memory",
    timestamp: new Date().toISOString()
  });
});
