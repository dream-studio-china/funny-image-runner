import { randomUUID } from "node:crypto";
import os from "node:os";
import sharp from "sharp";

const WEB = (process.env.WEB_API_BASE_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN ?? "";
const COMFY = (process.env.COMFY_BASE_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const POLL_MS = Math.max(1000, Number(process.env.WORKER_POLL_INTERVAL_MS ?? 4000) || 4000);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024;
const WORKER_ID = process.env.WORKER_ID || `comfy-${os.hostname()}`;
const WORKER_NAME = process.env.WORKER_NAME || WORKER_ID;
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
let stopping = false;
let activeAbort;
let workerState = "starting";
let currentJobId = null;
let lastError = null;
let lastStatusAt = 0;

function log(jobId, phase, code) {
  console.log(JSON.stringify({ job_id: jobId ?? null, phase, ...(code ? { error_code: code } : {}) }));
}
function safeCode(error) {
  const value = typeof error?.code === "string" ? error.code : "worker_error";
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : "worker_error";
}
function makeAbort(timeout = REQUEST_TIMEOUT_MS) {
  return AbortSignal.any([AbortSignal.timeout(timeout), ...(stopping ? [AbortSignal.abort()] : [])]);
}
async function json(response) {
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error("bad_json"), { code: "bad_json" }); }
  if (!response.ok) {
    const error = Object.assign(new Error("api_error"), { code: typeof data?.error === "string" ? data.error : `http_${response.status}`, status: response.status });
    stopIfUnauthorized(error);
    throw error;
  }
  return data;
}
async function api(path, method = "GET", body, signal) {
  try {
    return await fetch(`${WEB}${path}`, {
      method, signal: signal ?? makeAbort(),
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store",
    });
  } catch {
    throw Object.assign(new Error("cloud_api_network_error"), { code: "cloud_api_network_error" });
  }
}
async function apiJson(path, method, body, signal) { return json(await api(path, method, body, signal)); }
async function workerStatus(state = workerState, error = lastError, jobId = currentJobId) {
  workerState = state;
  lastError = error ?? null;
  currentJobId = jobId ?? null;
  await apiJson("/api/worker/heartbeat", "POST", { id: WORKER_ID, name: WORKER_NAME, state, currentJobId, lastError });
  lastStatusAt = Date.now();
}
function stopIfUnauthorized(error) {
  if (error?.status === 401 || error?.status === 403) {
    stopping = true;
    process.exitCode = 1;
    activeAbort?.abort();
  }
}
async function comfy(path, options = {}) {
  let response;
  try { response = await fetch(`${COMFY}${path}`, { ...options, signal: options.signal ?? makeAbort() }); }
  catch { throw Object.assign(new Error("comfy_network_error"), { code: "comfy_network_error" }); }
  if (!response.ok) throw Object.assign(new Error("comfy_error"), { code: `comfy_http_${response.status}` });
  return response;
}
function executionUncertain() { return Object.assign(new Error("execution_uncertain"), { code: "execution_uncertain" }); }
function queueContains(queue, promptId) {
  return ["queue_running", "queue_pending"].some((key) => Array.isArray(queue?.[key]) && queue[key].some((entry) => Array.isArray(entry) && entry[1] === promptId));
}
function setReference(workflow, reference, value) {
  if (!reference || typeof reference.nodeId !== "string" || typeof reference.inputName !== "string") throw Object.assign(new Error("invalid_node_mapping"), { code: "invalid_node_mapping" });
  const node = workflow[reference.nodeId];
  if (!node?.inputs || !Object.hasOwn(node.inputs, reference.inputName)) throw Object.assign(new Error("missing_node_input"), { code: "missing_node_input" });
  node.inputs[reference.inputName] = value;
}
function interpolate(template, parameters) {
  if (typeof template !== "string") return "";
  return template.replace(/{{\s*(mood|note)\s*}}/g, (_, key) => typeof parameters?.[key] === "string" ? parameters[key] : "");
}
function outputList(history, nodeIds) {
  const record = history?.[Object.keys(history ?? {})[0]] ?? history;
  const outputs = record?.outputs;
  if (!outputs || typeof outputs !== "object") return [];
  const files = [];
  for (const nodeId of nodeIds) {
    const images = outputs[nodeId]?.images;
    if (!Array.isArray(images)) continue;
    for (const image of images) if (typeof image?.filename === "string" && typeof image?.type === "string") files.push(image);
  }
  return files.slice(0, 4);
}
async function uploadMultipart(url, fields, bytes, contentType, filename, signal) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append("file", new Blob([bytes], { type: contentType }), filename);
  const response = await fetch(url, { method: "POST", body: form, signal: signal ?? makeAbort() });
  if (!response.ok) throw Object.assign(new Error("upload_failed"), { code: `upload_http_${response.status}` });
  return response;
}
async function download(url, signal) {
  let response;
  try { response = await fetch(url, { signal: signal ?? makeAbort(60_000) }); }
  catch { throw Object.assign(new Error("input_download_network_error"), { code: "input_download_network_error" }); }
  if (!response.ok) throw Object.assign(new Error("download_failed"), { code: `download_http_${response.status}` });
  const type = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!allowedTypes.has(type) || declared > MAX_BYTES) throw Object.assign(new Error("invalid_image"), { code: "invalid_image" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) throw Object.assign(new Error("invalid_image_size"), { code: "invalid_image_size" });
  return { bytes, type };
}
async function compactOutput(image, jobId) {
  if (image.type !== "image/png") return image;
  try {
    const stats = await sharp(image.bytes).stats();
    if (!stats.isOpaque) return image;
    const bytes = await sharp(image.bytes).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    if (bytes.length >= image.bytes.length) return image;
    log(jobId, "output_converted_to_jpeg");
    return { bytes, type: "image/jpeg" };
  } catch {
    return image;
  }
}
async function runHeartbeat(job, state) {
  while (!state.done && !stopping) {
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    if (state.done || stopping) break;
    try {
      await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/heartbeat`, "POST", {
        leaseToken: job.leaseToken, phase: state.phase, ...(state.promptId ? { promptId: state.promptId } : {}),
      });
    } catch (error) {
      state.lost = error.status === 409 || error.status === 401 || error.status === 403;
      state.heartbeatError = safeCode(error);
      if (state.lost) { activeAbort?.abort(); break; }
    }
  }
}
async function heartbeatNow(job, state, phase, promptId) {
  state.phase = phase;
  if (promptId) state.promptId = promptId;
  await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/heartbeat`, "POST", {
    leaseToken: job.leaseToken, phase, ...(promptId ? { promptId } : {}),
  });
}
async function processJob(job) {
  const state = { phase: job.phase ?? "claimed", done: false, lost: false, promptId: job.promptId ?? null };
  activeAbort = new AbortController();
  const hb = runHeartbeat(job, state);
  const baseSignal = AbortSignal.any([activeAbort.signal, makeAbort(20 * 60_000)]);
  try { await workerStatus("processing", null, job.id); }
  catch (error) { stopIfUnauthorized(error); if (stopping) state.lost = true; }
  try {
    if (state.lost) throw Object.assign(new Error("worker_status_unavailable"), { code: "worker_status_unavailable" });
    if (!state.promptId && job.phase === "prompt_submitting") throw executionUncertain();
    const presetData = await apiJson(`/api/worker/presets/${encodeURIComponent(job.presetId)}/versions/${job.presetVersion}`);
    const preset = presetData.preset;
    if (!preset?.workflow || !preset?.nodeMapping || !Array.isArray(preset.nodeMapping.outputNodeIds)) throw Object.assign(new Error("preset_invalid"), { code: "preset_invalid" });

    const mapping = preset.nodeMapping;
    let promptId = state.promptId;
    if (promptId) {
      let existingHistory = {};
      try {
        const historyResponse = await fetch(`${COMFY}/history/${encodeURIComponent(promptId)}`, { signal: baseSignal });
        if (historyResponse.ok) existingHistory = await historyResponse.json();
        else if (historyResponse.status !== 404) throw Object.assign(new Error("comfy_error"), { code: `comfy_http_${historyResponse.status}` });
      } catch (error) {
        if (error?.code) throw error;
        existingHistory = {};
      }
      if (!existingHistory?.[promptId]) {
        const queueResponse = await comfy("/queue", { signal: baseSignal });
        if (!queueContains(await queueResponse.json(), promptId)) throw executionUncertain();
      }
    } else {
      await heartbeatNow(job, state, "downloading_input");
      const inputData = await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/input-url`, "POST", { leaseToken: job.leaseToken });
      const input = await download(inputData.url, baseSignal);
      await heartbeatNow(job, state, "uploading_input");
      const comfyInput = await comfy("/upload/image", { method: "POST", body: (() => { const f = new FormData(); f.append("image", new Blob([input.bytes], { type: input.type }), "worker-input"); f.append("type", "input"); f.append("overwrite", "true"); return f; })(), signal: baseSignal }).then((r) => r.json());
      if (typeof comfyInput?.name !== "string") throw Object.assign(new Error("comfy_upload_invalid"), { code: "comfy_upload_invalid" });

      const workflow = structuredClone(preset.workflow);
      setReference(workflow, mapping.inputImage, comfyInput.name);
       if (mapping.prompt && typeof preset.prompt === "string" && preset.prompt.trim()) setReference(workflow, mapping.prompt, interpolate(preset.prompt, job.parameters));
       if (mapping.negativePrompt && typeof preset.negativePrompt === "string") setReference(workflow, mapping.negativePrompt, interpolate(preset.negativePrompt, job.parameters));
       if (mapping.additional && typeof mapping.additional === "object") for (const [key, ref] of Object.entries(mapping.additional)) {
         if (preset.additional && Object.hasOwn(preset.additional, key)) setReference(workflow, ref, preset.additional[key]);
       }
      await heartbeatNow(job, state, "prompt_submitting");
      let submitResponse;
      try {
        submitResponse = await fetch(`${COMFY}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }), signal: baseSignal });
      } catch { throw executionUncertain(); }
      if (submitResponse.status >= 500) throw executionUncertain();
      if (!submitResponse.ok) throw Object.assign(new Error("comfy_submission_rejected"), { code: `comfy_http_${submitResponse.status}` });
      let submit;
      try { submit = await submitResponse.json(); } catch { throw executionUncertain(); }
      if (typeof submit?.prompt_id !== "string" || !submit.prompt_id) throw executionUncertain();
      promptId = submit.prompt_id;
      try { await heartbeatNow(job, state, "generating", promptId); }
      catch { throw executionUncertain(); }
    }

    let files = [];
    const until = Date.now() + 20 * 60_000;
    while (Date.now() < until && !stopping && !state.lost) {
      const response = await comfy(`/history/${encodeURIComponent(promptId)}`, { signal: baseSignal });
      const history = await response.json();
      const record = history?.[promptId];
      if (record?.status?.status_str === "error") throw Object.assign(new Error("generation_failed"), { code: "generation_failed" });
      files = record?.status?.completed === true ? outputList(history, mapping.outputNodeIds) : [];
      if (files.length) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (state.lost) throw Object.assign(new Error("lease_invalid"), { code: "lease_invalid" });
    if (!files.length) throw Object.assign(new Error("generation_timeout"), { code: "generation_timeout" });
    const outputs = [];
    for (let index = 0; index < files.length; index++) {
      await heartbeatNow(job, state, "downloading_output", promptId);
      const file = files[index];
      const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
      const downloadedImage = await comfy(`/view?${params}`, { signal: baseSignal }).then(async (r) => ({ bytes: Buffer.from(await r.arrayBuffer()), type: (r.headers.get("content-type") ?? "").split(";")[0].toLowerCase() }));
      const image = await compactOutput(downloadedImage, job.id);
      if (!allowedTypes.has(image.type) || image.bytes.length < 1 || image.bytes.length > MAX_BYTES) throw Object.assign(new Error("invalid_output"), { code: "invalid_output" });
      await heartbeatNow(job, state, "uploading_output", promptId);
      const credential = await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/output-upload`, "POST", { leaseToken: job.leaseToken, index, size: image.bytes.length, contentType: image.type });
      const extension = image.type === "image/jpeg" ? "jpg" : image.type === "image/webp" ? "webp" : "png";
      await uploadMultipart(credential.uploadUrl, { token: credential.uploadToken, key: credential.key }, image.bytes, image.type, `output-${index}.${extension}`, baseSignal);
      outputs.push({ index, key: credential.key, contentType: image.type, size: image.bytes.length });
    }
    await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/complete`, "POST", { leaseToken: job.leaseToken, outputs });
    log(job.id, "complete");
  } catch (error) {
    if (!state.lost && !stopping) {
      const code = safeCode(error);
      try { await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/fail`, "POST", { leaseToken: job.leaseToken, errorCode: code }); } catch { /* lease may already be lost */ }
      log(job.id, state.phase, code);
    }
  } finally {
    state.done = true;
    activeAbort = undefined;
    await hb;
    if (!stopping && !state.lost) {
      try { await workerStatus("idle", null, null); }
      catch (error) { stopIfUnauthorized(error); log(null, "status", safeCode(error)); }
    }
  }
}

if (!WEB || !TOKEN) {
  console.error("WORKER_CONFIGURATION_MISSING");
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  if (stopping) return;
  try { await workerStatus("stopping", null, currentJobId); } catch (error) { stopIfUnauthorized(error); }
  stopping = true;
  activeAbort?.abort();
});

try { await workerStatus("starting", null, null); }
catch (error) { stopIfUnauthorized(error); log(null, "status", safeCode(error)); }
while (!stopping) {
  try {
    await comfy("/system_stats");
    await workerStatus("idle", null, null);
    break;
  } catch (error) {
    stopIfUnauthorized(error);
    const code = safeCode(error);
    if (Date.now() - lastStatusAt >= 15_000) {
      try { await workerStatus("starting", code, null); } catch (statusError) { stopIfUnauthorized(statusError); }
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

while (!stopping) {
  if (workerState === "idle" && Date.now() - lastStatusAt >= 15_000) {
    try { await workerStatus("idle", null, null); }
    catch (error) { stopIfUnauthorized(error); log(null, "status", safeCode(error)); }
  }
  try {
    const response = await api("/api/worker/jobs/claim", "POST", {});
    if (response.status === 204) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + Math.floor(Math.random() * 1000)));
      continue;
    }
    const { job } = await json(response);
    if (!job?.id || !job?.leaseToken || !job?.presetId || !Number.isSafeInteger(job.presetVersion) || (job.promptId != null && typeof job.promptId !== "string") || (job.phase != null && typeof job.phase !== "string")) throw Object.assign(new Error("invalid_claim"), { code: "invalid_claim" });
    log(job.id, "claimed");
    await processJob(job);
  } catch (error) {
    const code = safeCode(error);
    log(null, "poll", code);
    stopIfUnauthorized(error);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
