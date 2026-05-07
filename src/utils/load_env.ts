import dotenv from 'dotenv';

/**
 * Load `.env` so rotated keys (GROQ_API_KEY, GEMINI_API_KEY, GMAIL_*, etc.)
 * win over the values inherited from the parent process. server.ts is a
 * long-running Node process — once started, it caches whatever was in `.env`
 * at startup. When it spawns a scraper child, Node passes its env vars
 * through, so without `override: true` the child sees stale keys forever.
 *
 * `override: true` is too broad on its own: server.ts also injects values
 * programmatically via `spawn(... { env })` — SERVER_PORT, BROWSER_MODE,
 * FORCE_REDRAFT — and a `.env` line like `FORCE_REDRAFT=` would silently
 * clobber them, breaking the dashboard's child-to-server contract. So we
 * snapshot those known programmatic vars first and restore them after
 * dotenv runs. (Per Devin Review on PR #45.)
 *
 * Add new programmatic vars to `PROGRAMMATIC_KEYS` whenever server.ts (or
 * any other parent) starts injecting one — keeping the list explicit makes
 * it obvious which vars are NOT expected to come from `.env`.
 */
const PROGRAMMATIC_KEYS = [
  'SERVER_PORT',
  'BROWSER_MODE',
  'FORCE_REDRAFT',
] as const;

export function loadEnv(): void {
  const preserved: Record<string, string | undefined> = {};
  for (const k of PROGRAMMATIC_KEYS) preserved[k] = process.env[k];

  dotenv.config({ override: true });

  for (const k of PROGRAMMATIC_KEYS) {
    if (preserved[k] !== undefined) process.env[k] = preserved[k];
  }
}
