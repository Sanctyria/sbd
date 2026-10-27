import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { environment } from "../config/env.js";
import * as schema from "./schema.js";

export const pool = new Pool({
  connectionString: environment.DATABASE_URL,
  max: environment.NODE_ENV === "production" ? 10 : 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

export const database = drizzle(pool, { schema });
