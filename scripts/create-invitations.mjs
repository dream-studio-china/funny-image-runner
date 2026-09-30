import { createHash, createHmac } from "node:crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(bytes) {
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function formatCode(value) {
  return value.match(/.{1,5}/g).join("-");
}

function normalizeCode(value) {
  return value.normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
}

function parseSeed(value) {
  if (/^(?:[a-f0-9]{2}){32,}$/i.test(value)) return Buffer.from(value, "hex");
  const seed = Buffer.from(value, "base64");
  if (seed.length < 32) throw new Error("INVITE_SEED must contain at least 32 random bytes (base64 or hex)");
  return seed;
}

const [batchId, userId, countArg = "1", ordinalArg = "1"] = process.argv.slice(2);
const count = Number(countArg);
const ordinalStart = Number(ordinalArg);
const seedValue = process.env.INVITE_SEED;
const apiBaseUrl = process.env.APP_BASE_URL;
const adminToken = process.env.ADMIN_API_TOKEN;

if (!batchId || !/^[A-Za-z0-9_-]{1,80}$/.test(batchId)) {
  console.error("Usage: INVITE_SEED=... APP_BASE_URL=... ADMIN_API_TOKEN=... npm run invitations:create -- <batch-id> <user-id> [count] [ordinal-start]");
  process.exit(2);
}
if (!/^[A-Za-z0-9_-]{3,64}$/.test(userId ?? "")) throw new Error("user-id must be 3–64 letters, digits, underscore or hyphen");
if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(ordinalStart) || ordinalStart < 1) {
  throw new Error("count must be 1–100 and ordinal-start must be a positive integer");
}
if (!seedValue || !apiBaseUrl || !adminToken) throw new Error("INVITE_SEED, APP_BASE_URL and ADMIN_API_TOKEN are required");

const seed = parseSeed(seedValue);
const items = [];
const issuedCodes = [];
for (let i = 0; i < count; i += 1) {
  const ordinal = ordinalStart + i;
  const bytes = createHmac("sha256", seed)
    .update(`invite:v1:${batchId}:${ordinal}`)
    .digest()
    .subarray(0, 20);
  const code = formatCode(encodeBase32(bytes));
  const codeHash = createHash("sha256").update(normalizeCode(code)).digest("hex");
  items.push({ userId, batchId, ordinal, codeHash });
  issuedCodes.push({ userId, ordinal, code });
}

const endpoint = new URL("/api/admin/invitations/import", apiBaseUrl);
const response = await fetch(endpoint, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ items }),
});
if (!response.ok) {
  const result = await response.json().catch(() => ({}));
  throw new Error(`Import failed (${response.status}): ${result.error ?? "request_failed"}; no invite codes were printed`);
}

console.log(`Imported ${items.length} invitation(s) into batch ${batchId}. Deliver these links securely:`);
for (const item of issuedCodes) {
  const inviteUrl = new URL("/", apiBaseUrl);
  inviteUrl.hash = new URLSearchParams({ invite: item.code }).toString();
  console.log(`${item.userId}\t${item.ordinal}\t${inviteUrl.toString()}`);
}
