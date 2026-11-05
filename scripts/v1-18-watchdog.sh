#!/usr/bin/env bash
# V1-18 100 题看护：NInfer 崩溃 → 重启 → 续跑，直到 summary.json 生成。
#
# 为什么需要它：NInfer 0.19 在 RTX 5080 上会偶发 CUDA 崩溃（实测两种错误码：
# cudaErrorLaunchFailure 与 cudaErrorIllegalAddress，均伴随 nvlddmkm 事件 153）。
# 每次崩只丢当前题，已完成题都在 progress.jsonl 里；缺的只是一个自动重启。
#
# 配置固定（vision + prefill-chunk 128），不在中途换参数——同一批题必须同一口径。
# 若某次尝试启动失败（CUDA 在加载期崩），下一轮重试。
set -u

N=${N:-100}
RUN_DIR=${RUN_DIR:-C:/prts-benchmark/v1-18-n100-$(date +%Y-%m-%d)}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-16}
KV_DIR="C:/local-llm/kvmem/kvmem-v0.19.1-windows-x64-nvidia-50-unified"
MODEL="C:/local-llm/models/ninfer/qwen3_8_27b_iq3s_v3.ninfer"

mkdir -p "$RUN_DIR"
WD_LOG="$RUN_DIR/watchdog.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$WD_LOG"; }

wait_http() {
  local port="$1" tries="${2:-90}" i
  for ((i = 0; i < tries; i++)); do
    if curl -s -m 2 "http://127.0.0.1:${port}/v1/models" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

ensure_adapter() {
  if curl -s -m 2 http://127.0.0.1:18201/v1/models > /dev/null 2>&1; then return 0; fi
  log "adapter 未在 18201，重启"
  ( cd /c/prts-system && node scripts/ninfer-adapter.mjs >> "$RUN_DIR/adapter.log" 2>&1 & )
  wait_http 18201 30 || log "adapter 启动超时（继续，eval 会报错暴露）"
}

log "watchdog 启动：N=$N RUN_DIR=$RUN_DIR MAX_ATTEMPTS=$MAX_ATTEMPTS"

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if [ -f "$RUN_DIR/summary.json" ]; then
    log "summary.json 已存在，收工"
    exit 0
  fi
  ensure_adapter

  if curl -s -m 2 http://127.0.0.1:18200/v1/models > /dev/null 2>&1; then
    log "attempt $attempt：已在 18200 的服务仍存活，直接复用"
    SVC_PID=""
  else
    log "attempt $attempt：启动 NInfer"
    (
      cd "$KV_DIR" || exit 1
      PATH="$PWD/runtime/cuda:$PWD/workers/ninfer:$PATH" \
        ./workers/ninfer/ninfer-kvmem-server.exe "$MODEL" \
        --host 127.0.0.1 --port 18200 --max-context 262144 --max-concurrency 1 \
        --prefill-chunk 128 --kvmem-budget 36864 --kvmem-gen-reserve 16384 \
        --kvmem-host-mib 12288 --kvmem-sink-tokens 12288 --kvmem-recent-tokens 1024 \
        --kvmem-sessions 1 --kv-dtype int8 --device-profile off \
        --default-max-tokens 16384 --device 0 --spec mtp --draft-tokens 4 \
        --ngram-draft-tokens 0 --fast-prefill-kernel \
        --vision --vision-residency cpu --vision-max-merged 1024 \
        --default-thinking-budget 8192 --kvmem --kvmem-query-scorer page-softmax \
        --kvmem-score-agg mean --kvmem-graph-alpha 0.2 --no-kvmem-lrfu \
        --wddm-evictable-budget \
        --request-log-jsonl "C:/local-llm/infer-kvmem-requests-${attempt}.jsonl" \
        > "$RUN_DIR/ninfer-attempt-${attempt}.log" 2>&1
    ) &
    SVC_PID=$!
    if ! wait_http 18200 180; then
      log "attempt $attempt：服务 180s 内未就绪，下一轮"
      kill "$SVC_PID" 2>/dev/null
      wait "$SVC_PID" 2>/dev/null
      continue
    fi
    log "attempt $attempt：服务就绪（pid $SVC_PID）"
  fi

  ( cd /c/prts-system && \
    LOCAL=1 N="$N" DSH_CONTEXT_WINDOW=32768 LOCAL_BASE=http://127.0.0.1:18201 \
    RUN_DIR="$RUN_DIR" \
    node --disable-warning=ExperimentalWarning scripts/eval-v1-18-ab.mjs ) >> "$WD_LOG" 2>&1
  rc=$?
  log "attempt $attempt：eval 退出 rc=$rc"

  if [ -n "${SVC_PID:-}" ] && kill -0 "$SVC_PID" 2>/dev/null; then
    log "停止本轮服务 pid $SVC_PID"
    kill "$SVC_PID" 2>/dev/null
    wait "$SVC_PID" 2>/dev/null
  fi
  SVC_PID=""
  sleep 3
done

if [ -f "$RUN_DIR/summary.json" ]; then
  log "完成"
  exit 0
fi
log "达到最大尝试次数仍未完成"
exit 1
