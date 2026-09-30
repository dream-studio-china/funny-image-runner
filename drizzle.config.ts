import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const rawUrl = process.env.DATABASE_URL ?? "mysql://user:password@127.0.0.1:3306/funny_image_runner";
const url = new URL(rawUrl);
const ca = process.env.MYSQL_SSL_CA_BASE64
  ? Buffer.from(process.env.MYSQL_SSL_CA_BASE64, "base64").toString("utf8")
  : undefined;
const useTls = process.env.NODE_ENV === "production" || /\.tidbcloud\.com$/i.test(url.hostname);
const ssl = useTls
  ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
  : undefined;

export default defineConfig({
  dialect: "mysql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl,
  },
});
