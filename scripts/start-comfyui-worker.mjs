import { spawn } from "node:child_process";

const comfyBaseUrl = process.env.COMFY_BASE_URL ?? "http://127.0.0.1:8188";
let comfyHost;
try {
  comfyHost = new URL(comfyBaseUrl).hostname;
} catch {
  console.error("COMFY_BASE_URL_INVALID");
  process.exit(1);
}

const noProxyValues = [process.env.NO_PROXY, process.env.no_proxy]
  .filter(Boolean)
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
for (const host of ["localhost", "127.0.0.1", "::1", comfyHost]) {
  if (!noProxyValues.includes(host)) noProxyValues.push(host);
}

const env = {
  ...process.env,
  COMFY_BASE_URL: comfyBaseUrl,
  NODE_USE_ENV_PROXY: "1",
  NO_PROXY: noProxyValues.join(","),
  no_proxy: noProxyValues.join(","),
};
const child = spawn(process.execPath, ["--use-env-proxy", "scripts/comfyui-worker.mjs"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", () => {
  console.error("WORKER_START_FAILED");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
