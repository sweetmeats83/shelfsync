export interface Config {
  port: number;
  databasePath: string;
  calibreDbPath: string;
  hardcoverToken: string;
  absUrl: string;
  absToken: string;
  absPollMinutes: number;
  /** Minimum minutes between progress pushes for one book. */
  pushIntervalMinutes: number;
  /** Ignore ABS items not updated within this many days (keeps the old backlog out). */
  absMaxAgeDays: number;
  adminPassword: string;
  registrationDisabled: boolean;
  dryRun: boolean;
  /** Background job that resolves a Hardcover book for the whole Calibre library. */
  libraryMatch: boolean;
  /** Owner's timezone: "today" for started/finished dates. */
  tz: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    databasePath: env.DATABASE_PATH ?? "/data/shelfsync.db",
    calibreDbPath: env.CALIBRE_DB_PATH ?? "/calibre/metadata.db",
    hardcoverToken: (env.HARDCOVER_TOKEN ?? "").replace(/^Bearer\s+/i, ""),
    absUrl: (env.ABS_URL ?? "").replace(/\/+$/, ""),
    absToken: env.ABS_TOKEN ?? "",
    absPollMinutes: Number(env.ABS_POLL_MINUTES ?? 5),
    pushIntervalMinutes: Number(env.PUSH_INTERVAL_MINUTES ?? 10),
    absMaxAgeDays: Number(env.ABS_MAX_AGE_DAYS ?? 3),
    adminPassword: env.ADMIN_PASSWORD ?? "",
    registrationDisabled: env.REGISTRATION_DISABLED === "true",
    dryRun: env.DRY_RUN !== "false", // dry-run unless explicitly disabled
    libraryMatch: env.LIBRARY_MATCH !== "false",
    tz: env.TZ || "America/Chicago",
  };
}
