#!/usr/bin/env bash
# Standalone Linux worker. Requirements: Bash 4+, curl, jq, file.
set -uo pipefail

: "${WEB_API_BASE_URL:?Set WEB_API_BASE_URL to the deployed website root}"
: "${WORKER_TOKEN:?Set WORKER_TOKEN to the same secret as the website}"
COMFY_BASE_URL="${COMFY_BASE_URL:-http://127.0.0.1:8188}"
WORKER_ID="${WORKER_ID:-comfy-$(hostname -s 2>/dev/null || hostname)}"
WORKER_NAME="${WORKER_NAME:-$WORKER_ID}"
WORKER_POLL_INTERVAL_SEC="${WORKER_POLL_INTERVAL_SEC:-4}"
WORKER_PYTHON="${WORKER_PYTHON:-python3}"
MAX_IMAGE_BYTES=$((20 * 1024 * 1024))
WEB_API_BASE_URL="${WEB_API_BASE_URL%/}"
COMFY_BASE_URL="${COMFY_BASE_URL%/}"

for cmd in curl jq file; do command -v "$cmd" >/dev/null 2>&1 || { echo "Missing dependency: $cmd" >&2; exit 1; }; done

# Keep the normal HTTPS proxy for the website/Qiniu but bypass it for ComfyUI/Tailscale.
COMFY_HOST="${COMFY_BASE_URL#*://}"
COMFY_HOST="${COMFY_HOST%%/*}"
COMFY_HOST="${COMFY_HOST%%:*}"
NO_PROXY="${NO_PROXY:-${no_proxy:-}}"
for bypass in localhost 127.0.0.1 ::1 "$COMFY_HOST"; do
  case ",$NO_PROXY," in *",$bypass,"*) ;; *) NO_PROXY="${NO_PROXY:+$NO_PROXY,}$bypass" ;; esac
done
export NO_PROXY no_proxy="$NO_PROXY"
exec 3>&1

TMP_DIR="$(mktemp -d)"
STOPPING=0
ACTIVE_JOB=""
ACTIVE_LEASE=""
LAST_STATUS=0
LAST_WORKER_STATE=""
LAST_IDLE_LOG=0

log() {
  jq -cn --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg worker "$WORKER_ID" --arg job_id "${1:-}" --arg phase "${2:-}" --arg error_code "${3:-}" \
    '{time:$time,worker_id:$worker,job_id:(if $job_id=="" then null else $job_id end),phase:$phase} + (if $error_code=="" then {} else {error_code:$error_code} end)'
}
log_detail() {
  jq -cn --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg worker "$WORKER_ID" --arg job_id "${1:-}" --arg phase "${2:-}" --arg detail "${3:-}" \
    '{time:$time,worker_id:$worker,job_id:(if $job_id=="" then null else $job_id end),phase:$phase,detail:$detail}'
}
api_request() {
  local method="$1" path="$2" body="${3:-}" out="$4" code rc
  local args=(--silent --show-error --connect-timeout 10 --max-time 30 -X "$method" \
    -H "Authorization: Bearer $WORKER_TOKEN" -H "Accept: application/json" -o "$out" -w '%{http_code}')
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  code="$(curl "${args[@]}" "$WEB_API_BASE_URL$path" 2>/dev/null)"; rc=$?
  if (( rc != 0 )); then printf '000'; else printf '%s' "$code"; fi
}
comfy_request() {
  local method="$1" path="$2" out="$3" code rc
  shift 3
  code="$(curl --silent --show-error --connect-timeout 5 --max-time 60 -X "$method" -o "$out" -w '%{http_code}' "$@" "$COMFY_BASE_URL$path" 2>/dev/null)"; rc=$?
  if (( rc != 0 )); then printf '000'; else printf '%s' "$code"; fi
}
worker_status() {
  local state="$1" job_id="${2:-}" error="${3:-}"
  local body out="$TMP_DIR/worker-status.json" code
  body="$(jq -cn --arg id "$WORKER_ID" --arg name "$WORKER_NAME" --arg state "$state" \
    --arg job_id "$job_id" --arg error "$error" \
    '{id:$id,name:$name,state:$state,currentJobId:(if $job_id=="" then null else $job_id end),lastError:(if $error=="" then null else $error end)}')"
  code="$(api_request POST /api/worker/heartbeat "$body" "$out")"
  if [[ "$code" == 200 ]]; then
    LAST_STATUS=$(date +%s)
    if [[ "$LAST_WORKER_STATE" != "$state" ]]; then log_detail "${job_id:-}" worker_status "state=$state" >&3; fi
    LAST_WORKER_STATE="$state"
  else
    log "${job_id:-}" worker_status "heartbeat_http_$code" >&3
  fi
  [[ "$code" == 200 ]]
}
job_heartbeat() {
  local job_id="$1" lease="$2" phase="$3" prompt_id="${4:-}" out="$TMP_DIR/hb.json" body code
  body="$(jq -cn --arg lease "$lease" --arg phase "$phase" --arg prompt "$prompt_id" \
    '{leaseToken:$lease,phase:$phase} + (if $prompt=="" then {} else {promptId:$prompt} end)')"
  code="$(api_request POST "/api/worker/jobs/$job_id/heartbeat" "$body" "$out")"
  [[ "$code" == 200 ]]
}
set_phase() { job_heartbeat "$ACTIVE_JOB" "$ACTIVE_LEASE" "$1" "${2:-}"; }
fail_job() {
  local job_id="$1" lease="$2" code="$3" out="$TMP_DIR/fail.json" body
  body="$(jq -cn --arg lease "$lease" --arg error "$code" '{leaseToken:$lease,errorCode:$error}')"
  api_request POST "/api/worker/jobs/$job_id/fail" "$body" "$out" >/dev/null || true
  log "$job_id" failed "$code"
}
set_workflow_reference() {
  jq -ce --argjson r "$2" --argjson v "$3" '(.[$r.nodeId].inputs[$r.inputName])=$v' <<<"$1"
}
interpolate_prompt() {
  jq -rn --arg s "$1" --arg mood "$2" --arg note "$3" \
    '$s | gsub("{{\\s*mood\\s*}}";$mood) | gsub("{{\\s*note\\s*}}";$note)'
}
upload_to_comfy() {
  local file_path="$1" mime="$2" filename="$3" out="$TMP_DIR/comfy-upload.json" code
  code="$(comfy_request POST /upload/image "$out" -F "image=@$file_path;type=$mime;filename=$filename" -F 'type=input' -F 'overwrite=true')"
  [[ "$code" == 200 ]] || return 1
  jq -er '.name | strings | select(length>0)' "$out"
}
jpegify_opaque_png() {
  local source="$1" destination="$2"
  command -v "$WORKER_PYTHON" >/dev/null 2>&1 || return 1
  "$WORKER_PYTHON" - "$source" "$destination" <<'PY'
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit(3)

source, destination = sys.argv[1:3]
try:
    with Image.open(source) as image:
        rgba = image.convert("RGBA")
        if rgba.getchannel("A").getextrema()[0] < 255:
            sys.exit(2)
        image.convert("RGB").save(destination, format="JPEG", quality=88, optimize=True, progressive=True, icc_profile=image.info.get("icc_profile"))
    if os.path.getsize(destination) >= os.path.getsize(source):
        os.remove(destination)
        sys.exit(4)
except Exception:
    try:
        os.remove(destination)
    except OSError:
        pass
    sys.exit(5)
PY
}

process_job() {
  local job="$1" job_id lease preset_id preset_version phase prompt_id
  local preset_file input_url input_type input_size input_file comfy_name workflow map prompt negative additional output_nodes
  local response_file code body client_id submit_file submit history_file files_file count index item filename subfolder type view_url output_file converted_file output_size credential_url credential_token output_key outputs
  job_id="$(jq -r '.id' <<<"$job")"; lease="$(jq -r '.leaseToken' <<<"$job")"
  preset_id="$(jq -r '.presetId' <<<"$job")"; preset_version="$(jq -r '.presetVersion' <<<"$job")"
  phase="$(jq -r '.phase // "claimed"' <<<"$job")"; prompt_id="$(jq -r '.promptId // ""' <<<"$job")"
  ACTIVE_JOB="$job_id"; ACTIVE_LEASE="$lease"
  log "$job_id" claimed
  worker_status processing "$job_id" "" || true

  preset_file="$TMP_DIR/preset-$job_id.json"
  log "$job_id" preset_config_request
  code="$(api_request GET "/api/worker/presets/$preset_id/versions/$preset_version" "" "$preset_file")"
  if [[ "$code" != 200 ]]; then fail_job "$job_id" "$lease" "preset_config_unavailable"; worker_status idle "" "" || true; return; fi
  workflow="$(jq -c '.preset.workflow' "$preset_file")"; map="$(jq -c '.preset.nodeMapping' "$preset_file")"
  prompt="$(jq -r '.preset.prompt // ""' "$preset_file")"; negative="$(jq -r '.preset.negativePrompt // ""' "$preset_file")"
  additional="$(jq -c '.preset.additional // {}' "$preset_file")"; output_nodes="$(jq -c '.outputNodeIds' <<<"$map")"
  log_detail "$job_id" preset_config_loaded "preset=$preset_id version=$preset_version output_nodes=$(jq -r 'join(",")' <<<"$output_nodes")"

  if [[ -z "$prompt_id" ]]; then
    set_phase downloading_input || { fail_job "$job_id" "$lease" "lease_invalid"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    log "$job_id" input_url_request
    response_file="$TMP_DIR/input-url-$job_id.json"; body="$(jq -cn --arg lease "$lease" '{leaseToken:$lease}')"
    code="$(api_request POST "/api/worker/jobs/$job_id/input-url" "$body" "$response_file")"
    if [[ "$code" != 200 ]]; then fail_job "$job_id" "$lease" "input_url_http_$code"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    input_url="$(jq -r '.url' "$response_file")"; input_type="$(jq -r '.contentType' "$response_file")"; input_size="$(jq -r '.size' "$response_file")"
    input_file="$TMP_DIR/input-$job_id"
    log_detail "$job_id" input_download_started "content_type=$input_type declared_bytes=$input_size"
    code="$(curl --silent --show-error --connect-timeout 10 --max-time 60 -L -o "$input_file" -w '%{http_code}' "$input_url" 2>/dev/null)"; curl_rc=$?
    if (( curl_rc != 0 )); then log_detail "$job_id" input_download_failed "curl_exit=$curl_rc http_code=$code"; fail_job "$job_id" "$lease" "input_download_curl_$curl_rc"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    if [[ "$code" != 200 ]]; then log_detail "$job_id" input_download_failed "http_code=$code"; fail_job "$job_id" "$lease" "input_download_http_$code"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    log_detail "$job_id" input_downloaded "bytes=$(wc -c < "$input_file" | tr -d ' ')"
    if [[ "$(wc -c < "$input_file" | tr -d ' ')" -gt "$MAX_IMAGE_BYTES" ]]; then fail_job "$job_id" "$lease" "input_too_large"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    set_phase uploading_input || { fail_job "$job_id" "$lease" "lease_invalid"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    case "$input_type" in image/png) filename=worker-input.png;; image/jpeg) filename=worker-input.jpg;; image/webp) filename=worker-input.webp;; *) fail_job "$job_id" "$lease" "input_type_invalid"; worker_status idle "" "" >/dev/null 2>&1 || true; return;; esac
    log_detail "$job_id" comfy_input_upload_started "content_type=$input_type"
    comfy_name="$(upload_to_comfy "$input_file" "$input_type" "$filename")" || { fail_job "$job_id" "$lease" "comfy_input_upload_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    subfolder="$(jq -r '.subfolder // ""' "$TMP_DIR/comfy-upload.json")"
    [[ -z "$subfolder" ]] || comfy_name="$subfolder/$comfy_name"
    log "$job_id" comfy_input_uploaded

    workflow="$(set_workflow_reference "$workflow" "$(jq -c '.inputImage' <<<"$map")" "$(jq -Rn --arg s "$comfy_name" '$s')")" || { fail_job "$job_id" "$lease" "input_node_mapping_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    if [[ -n "$prompt" ]]; then
      prompt="$(interpolate_prompt "$prompt" "$(jq -r '.parameters.mood // ""' <<<"$job")" "$(jq -r '.parameters.note // ""' <<<"$job")")"
      workflow="$(set_workflow_reference "$workflow" "$(jq -c '.prompt' <<<"$map")" "$(jq -Rn --arg s "$prompt" '$s')")" || { fail_job "$job_id" "$lease" "prompt_node_mapping_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    fi
    if [[ -n "$negative" ]]; then
      negative="$(interpolate_prompt "$negative" "$(jq -r '.parameters.mood // ""' <<<"$job")" "$(jq -r '.parameters.note // ""' <<<"$job")")"
      workflow="$(set_workflow_reference "$workflow" "$(jq -c '.negativePrompt' <<<"$map")" "$(jq -Rn --arg s "$negative" '$s')")" || { fail_job "$job_id" "$lease" "negative_node_mapping_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    fi
    while IFS=$'\t' read -r key value; do
      [[ -n "$key" ]] || continue
      ref="$(jq -c --arg k "$key" '.additional[$k]' <<<"$map")"
      [[ "$ref" != "null" ]] || continue
      workflow="$(set_workflow_reference "$workflow" "$ref" "$value")" || { fail_job "$job_id" "$lease" "additional_node_mapping_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    done < <(jq -r 'to_entries[] | [.key,(.value|tojson)] | @tsv' <<<"$additional")
    set_phase prompt_submitting || { fail_job "$job_id" "$lease" "lease_invalid"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    log "$job_id" comfy_prompt_submit_started
    client_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s)"
    submit_body="$(jq -cn --argjson prompt "$workflow" --arg client "$client_id" '{prompt:$prompt,client_id:$client}')"
    submit_file="$TMP_DIR/submit-$job_id.json"; code="$(comfy_request POST /prompt "$submit_file" -H 'Content-Type: application/json' --data-binary "$submit_body")"
    if [[ "$code" != 200 ]]; then fail_job "$job_id" "$lease" "execution_uncertain"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    prompt_id="$(jq -r '.prompt_id // empty' "$submit_file")"
    if [[ -z "$prompt_id" ]]; then fail_job "$job_id" "$lease" "execution_uncertain"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    log "$job_id" comfy_prompt_accepted
    set_phase generating "$prompt_id" || { fail_job "$job_id" "$lease" "execution_uncertain"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
  else
    history_file="$TMP_DIR/history-$job_id.json"
    code="$(comfy_request GET "/history/$prompt_id" "$history_file")"
    if [[ "$code" != 200 ]] || ! jq -e --arg id "$prompt_id" 'has($id)' "$history_file" >/dev/null 2>&1; then
      code="$(comfy_request GET /queue "$TMP_DIR/queue-$job_id.json")"
      if [[ "$code" != 200 ]] || ! jq -e --arg id "$prompt_id" '[.queue_running[],.queue_pending[]][] | .[1] == $id' "$TMP_DIR/queue-$job_id.json" >/dev/null 2>&1; then
        fail_job "$job_id" "$lease" "execution_uncertain"; worker_status idle "" "" >/dev/null 2>&1 || true; return
      fi
    fi
  fi

  history_file="$TMP_DIR/history-$job_id.json"; files_file="$TMP_DIR/files-$job_id.json"
  local deadline=$((SECONDS+1200)) last_progress=0; outputs='[]'
  log "$job_id" comfy_generation_poll_started
  while (( SECONDS < deadline && !STOPPING )); do
    set_phase generating "$prompt_id" || { fail_job "$job_id" "$lease" "lease_invalid"; worker_status idle "" "" >/dev/null 2>&1 || true; return; }
    code="$(comfy_request GET "/history/$prompt_id" "$history_file")"
    if [[ "$code" != 200 ]]; then sleep 3; continue; fi
    if [[ "$(jq -r --arg id "$prompt_id" '.[$id].status.status_str // ""' "$history_file")" == "error" ]]; then fail_job "$job_id" "$lease" "generation_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    jq -c --arg id "$prompt_id" --argjson nodes "$output_nodes" '.[$id] as $h | if $h.status.completed then [$nodes[] as $n | $h.outputs[$n].images[]?] else [] end' "$history_file" > "$files_file"
    if (( SECONDS - last_progress >= 30 )); then log_detail "$job_id" comfy_generation_waiting "elapsed_seconds=$((1200-(deadline-SECONDS)))"; last_progress=$SECONDS; fi
    count="$(jq 'length' "$files_file")"; (( count > 0 )) && break; sleep 3
  done
  count="$(jq 'length' "$files_file" 2>/dev/null || echo 0)"
  if (( count == 0 )); then fail_job "$job_id" "$lease" "generation_timeout"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
  log_detail "$job_id" comfy_generation_completed "outputs=$count"

  for ((index=0; index<count && index<4; index++)); do
    item="$(jq -c ".[$index]" "$files_file")"; filename="$(jq -r '.filename' <<<"$item")"; subfolder="$(jq -r '.subfolder // ""' <<<"$item")"; type="$(jq -r '.type // "output"' <<<"$item")"
    view_url="$COMFY_BASE_URL/view?filename=$(jq -rn --arg s "$filename" '$s|@uri')&subfolder=$(jq -rn --arg s "$subfolder" '$s|@uri')&type=$(jq -rn --arg s "$type" '$s|@uri')"
    output_file="$TMP_DIR/output-$index-$job_id"; code="$(curl --silent --show-error --connect-timeout 5 --max-time 60 -L -o "$output_file" -w '%{http_code}' "$view_url" 2>/dev/null)"; curl_rc=$?
    if (( curl_rc != 0 )); then fail_job "$job_id" "$lease" "comfy_output_curl_$curl_rc"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    if [[ "$code" != 200 ]]; then fail_job "$job_id" "$lease" "comfy_output_download_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    output_size="$(wc -c < "$output_file" | tr -d ' ')"; type="$(file --brief --mime-type "$output_file")"
    if [[ "$type" == "image/png" ]]; then
      converted_file="$output_file.jpg"
      if jpegify_opaque_png "$output_file" "$converted_file"; then
        output_file="$converted_file"; type="image/jpeg"
        log_detail "$job_id" comfy_output_converted "index=$index format=jpeg quality=88"
      else
        rm -f "$converted_file"
      fi
      output_size="$(wc -c < "$output_file" | tr -d ' ')"
    fi
    log_detail "$job_id" comfy_output_downloaded "index=$index content_type=$type bytes=$output_size"
    response_file="$TMP_DIR/output-credential-$job_id-$index.json"; body="$(jq -cn --arg lease "$lease" --arg type "$type" --argjson index "$index" --argjson size "$output_size" '{leaseToken:$lease,index:$index,contentType:$type,size:$size}')"
    code="$(api_request POST "/api/worker/jobs/$job_id/output-upload" "$body" "$response_file")"
    if [[ "$code" != 200 ]]; then fail_job "$job_id" "$lease" "output_credential_failed"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    output_key="$(jq -r '.key' "$response_file")"; credential_url="$(jq -r '.uploadUrl' "$response_file")"; credential_token="$(jq -r '.uploadToken' "$response_file")"
    log_detail "$job_id" qiniu_output_upload_started "index=$index content_type=$type bytes=$output_size"
    code="$(curl --silent --show-error --connect-timeout 10 --max-time 60 -o /dev/null -w '%{http_code}' -F "token=$credential_token" -F "key=$output_key" -F "file=@$output_file;type=$type;filename=output-$index" "$credential_url" 2>/dev/null)"; curl_rc=$?
    if (( curl_rc != 0 )); then log_detail "$job_id" qiniu_output_upload_failed "curl_exit=$curl_rc http_code=$code"; fail_job "$job_id" "$lease" "output_upload_curl_$curl_rc"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    if [[ "$code" != 200 ]]; then log_detail "$job_id" qiniu_output_upload_failed "http_code=$code"; fail_job "$job_id" "$lease" "output_upload_http_$code"; worker_status idle "" "" >/dev/null 2>&1 || true; return; fi
    log_detail "$job_id" qiniu_output_uploaded "index=$index bytes=$output_size"
    outputs="$(jq -c --arg key "$output_key" --arg type "$type" --argjson i "$index" --argjson size "$output_size" '. + [{index:$i,key:$key,contentType:$type,size:$size}]' <<<"$outputs")"
  done
  body="$(jq -cn --arg lease "$lease" --argjson outputs "$outputs" '{leaseToken:$lease,outputs:$outputs}')"
  code="$(api_request POST "/api/worker/jobs/$job_id/complete" "$body" "$TMP_DIR/complete-$job_id.json")"
  if [[ "$code" == 200 ]]; then log "$job_id" complete; else fail_job "$job_id" "$lease" "completion_failed"; fi
  worker_status idle "" "" >/dev/null 2>&1 || true
}

monitor_comfy() {
  log_detail "" comfy_connecting "host=$COMFY_HOST"
  worker_status starting "" comfy_unreachable >/dev/null 2>&1 || true
  while (( !STOPPING )); do
    code="$(comfy_request GET /system_stats "$TMP_DIR/comfy-health.json")"
    if [[ "$code" == 200 ]]; then log "" comfy_connected; worker_status idle "" "" >/dev/null 2>&1 || true; return 0; fi
    worker_status starting "" comfy_unreachable >/dev/null 2>&1 || true
    sleep 5
  done
  return 1
}

queue_once() {
  local response_file="$TMP_DIR/claim.json" code job
  code="$(api_request POST /api/worker/jobs/claim '{}' "$response_file")"
  case "$code" in
    204) return 1;;
    401|403) log "" auth "$code"; STOPPING=1; return 2;;
    200) job="$(cat "$response_file")";;
    *) log "" claim "claim_http_$code"; return 2;;
  esac
  process_job "$(jq -c '.job' <<<"$job")"
  return 0
}

trap 'STOPPING=1; worker_status stopping "" "" >/dev/null 2>&1 || true; rm -rf "$TMP_DIR"; exit 0' TERM INT
worker_status starting "" "" >/dev/null 2>&1 || true
monitor_comfy
while (( !STOPPING )); do
  if (( $(date +%s) - LAST_STATUS >= 15 )); then worker_status idle "" "" >/dev/null 2>&1 || true; fi
  queue_once; result=$?
  if (( result == 1 )); then
    if (( $(date +%s) - LAST_IDLE_LOG >= 30 )); then log "" queue_empty "next_poll_seconds=$WORKER_POLL_INTERVAL_SEC"; LAST_IDLE_LOG=$(date +%s); fi
    sleep "$WORKER_POLL_INTERVAL_SEC"
  fi
  if (( result == 2 )); then sleep "$WORKER_POLL_INTERVAL_SEC"; fi
done
