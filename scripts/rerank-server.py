"""常驻 reranker 服务：NDJSON over stdio，供 `src/memory/rerank.ts` 调用。

协议（一行一个 JSON）：
  请求  {"id": 1, "query": "...", "docs": ["...", "..."]}
  响应  {"id": 1, "scores": [0.9, 0.1]}
  错误  {"id": 1, "error": "..."}

为什么用 stdio 而不是 HTTP：不占端口、不需要鉴权、父子进程生命周期天然绑定。
为什么不是 Node 实现：sentence-transformers / CrossEncoder 只在 Python 生态里，
且把 torch 拉进 Node 端会破坏「纯 Node」的依赖面。

模型默认 `cross-encoder/ms-marco-MiniLM-L-6-v2`（22M）。同口径实测里它优于
bge-reranker-v2-m3（568M）与 bge-reranker-base（278M）——任务匹配度比参数量重要，
细节见 `docs/memory-recall-criteria-retest-2026-11-03.md`。

用法：
  python scripts/rerank-server.py [--model NAME] [--max-length 512] [--device cpu]
"""
import argparse
import json
import os
import sys

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='cross-encoder/ms-marco-MiniLM-L-6-v2')
    ap.add_argument('--max-length', type=int, default=512)
    ap.add_argument('--device', default='cpu')
    args = ap.parse_args()

    # 模型加载失败要让父进程看到原因：stderr 会被 Node 侧截取尾部做诊断。
    try:
        from sentence_transformers import CrossEncoder
        model = CrossEncoder(args.model, max_length=args.max_length, device=args.device)
    except Exception as exc:  # noqa: BLE001
        print(f'rerank-server: 模型加载失败 {args.model}: {exc}', file=sys.stderr, flush=True)
        return 2

    print(f'rerank-server: ready model={args.model} device={args.device}', file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get('id')
            docs = req.get('docs') or []
            if not docs:
                out = {'id': req_id, 'scores': []}
            else:
                pairs = [(req.get('query', ''), str(d)) for d in docs]
                scores = model.predict(pairs, batch_size=32, show_progress_bar=False)
                out = {'id': req_id, 'scores': [float(x) for x in scores]}
        except Exception as exc:  # noqa: BLE001
            out = {'id': req_id, 'error': str(exc)}
        print(json.dumps(out), flush=True)

    return 0


if __name__ == '__main__':
    sys.exit(main())
