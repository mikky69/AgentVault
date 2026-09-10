import pg from "pg";

let pool: pg.Pool | undefined;

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL must be set. Use the Supabase Postgres connection string in production.");
  return value;
}

export function getDatabase(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(),
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    });
  }
  return pool;
}

export async function checkDatabase(): Promise<void> {
  await getDatabase().query("select 1");
}
