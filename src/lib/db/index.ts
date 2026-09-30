import "server-only";
import mysql, { type Pool } from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "./schema";

type Database = MySql2Database<typeof schema>;

const globalForDatabase = globalThis as typeof globalThis & {
  mysqlPool?: Pool;
  drizzleDb?: Database;
};

function createPool(): Pool {
  const connectionUrl = process.env.DATABASE_URL;
  if (!connectionUrl) throw new Error("DATABASE_URL is required to access the database");

  const url = new URL(connectionUrl);
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql:// protocol");

  const ca = process.env.MYSQL_SSL_CA_BASE64
    ? Buffer.from(process.env.MYSQL_SSL_CA_BASE64, "base64").toString("utf8")
    : undefined;
  const useTls = process.env.NODE_ENV === "production" || /\.tidbcloud\.com$/i.test(url.hostname);
  const ssl = useTls
    ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
    : undefined;

  return mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 5),
    queueLimit: 0,
    timezone: "Z",
    charset: "utf8mb4",
    ssl,
  });
}

export function getPool(): Pool {
  globalForDatabase.mysqlPool ??= createPool();
  return globalForDatabase.mysqlPool;
}

export function getDb(): Database {
  globalForDatabase.drizzleDb ??= drizzle({ client: getPool(), schema, mode: "default" });
  return globalForDatabase.drizzleDb;
}

export { schema };
