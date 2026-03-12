/**
 * Applies db/migrations/001_initial_schema.sql to the configured Supabase project
 * via the Management API.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=<personal-access-token> npx tsx scripts/migrate.ts
 *
 * Get your personal access token at: https://supabase.com/dashboard/account/tokens
 *
 * If you don't want to use the Management API, paste the SQL from
 * db/migrations/001_initial_schema.sql directly into the Supabase SQL Editor:
 * https://supabase.com/dashboard/project/<project-ref>/sql/new
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const SQL_PATH = resolve(__dirname, "../db/migrations/001_initial_schema.sql");
const sql = readFileSync(SQL_PATH, "utf8");

const SUPABASE_URL = process.env["SUPABASE_URL"];
const ACCESS_TOKEN = process.env["SUPABASE_ACCESS_TOKEN"];

if (!SUPABASE_URL) {
  console.error("SUPABASE_URL is not set in .env");
  process.exit(1);
}

// Extract project ref from the URL: https://<project-ref>.supabase.co
const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function applyViaManagementApi(): Promise<void> {
  if (!ACCESS_TOKEN) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN is not set.\n" +
        "Visit https://supabase.com/dashboard/account/tokens to generate one.\n" +
        "Then re-run:\n" +
        "  SUPABASE_ACCESS_TOKEN=your-token npx tsx scripts/migrate.ts\n\n" +
        "Alternatively, apply the SQL manually in the Supabase SQL Editor:\n" +
        `  https://supabase.com/dashboard/project/${projectRef}/sql/new`
    );
  }

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`
      },
      body: JSON.stringify({ query: sql })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Management API returned ${response.status}: ${body}\n\n` +
        "Alternatively, apply the SQL manually in the Supabase SQL Editor:\n" +
        `  https://supabase.com/dashboard/project/${projectRef}/sql/new`
    );
  }

  const result = await response.json();
  console.log("Migration applied successfully.", result);
}

applyViaManagementApi().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
