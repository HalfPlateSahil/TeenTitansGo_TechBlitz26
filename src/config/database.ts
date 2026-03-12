import { createClient } from "@supabase/supabase-js";

import { env, hasSupabaseConfig } from "./env.js";

export const supabase = hasSupabaseConfig
  ? createClient(env.supabaseUrl!, env.supabaseServiceRoleKey!, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;
