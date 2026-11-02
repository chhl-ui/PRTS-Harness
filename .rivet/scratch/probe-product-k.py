"""产品真实口径重算：注入条数是 5，不是 8。

`memory-inject.ts:169-181`：候选池 `limit * 3 = 15`，最终 `slice(0, limit) = 5` 条注入。
之前 rerank 实验用的是「候选 32 → 判 @8」，比产品宽松两档。本脚本按产品口径重算：

  A. 候选 32 → @5 / @8 / @16（看减少注入条数后 rerank 还值不值）
  B. 候选 15（= 产品 limit*3）→ @5（完全对齐生产）

用法：python probe-product-k.py [model]
"""
import json
import os
import sys
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from sentence_transformers import CrossEncoder  # noqa: E402

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'cross-encoder/ms-marco-MiniLM-L-6-v2'
DATA = 'C:/prts-benchmark/rerank-cands.json'
PRODUCT_POOL = 15
PRODUCT_INJECT = 5


def first_rank(cands, golds):
    for i, c in enumerate(cands):
        if c['text'][:60] in golds:
            return i + 1
    return -1


def hit(rows, key, k):
    return sum(1 for r in rows if 0 < r[key] <= k)


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    model = CrossEncoder(MODEL, max_length=512, device='cpu')
    print(f'模型 {MODEL}  题数 {len(data)}')

    rows = []
    t0 = time.time()
    for it in data:
        if not it['cands']:
            continue
        cands32 = it['cands']
        cands15 = cands32[:PRODUCT_POOL]
        # 一次前向覆盖两个候选池（15 是 32 的前缀，按 32 打分再截断即等价）
        pairs = [(it['question'], c['text']) for c in cands32]
        scores = model.predict(pairs, batch_size=32, show_progress_bar=False)
        order = sorted(range(len(scores)), key=lambda i: -float(scores[i]))
        reranked32 = [cands32[i] for i in order]
        reranked15 = [c for c in reranked32 if c in cands15]  # 保持 rerank 顺序，只留产品池内的

        rows.append({
            'type': it['type'],
            'orig32': first_rank(cands32, it['golds']),
            'orig15': first_rank(cands15, it['golds']),
            're32': first_rank(reranked32, it['golds']),
            're15': first_rank(reranked15, it['golds']),
        })
    print(f'推理 {time.time() - t0:.0f}s')

    n = len(rows)
    pct = lambda a: f'{a}/{n} = {a / n * 100:.1f}%'

    print(f'\n=== A. 候选 32 ===')
    for k in (5, 8, 16):
        o = hit(rows, 'orig32', k)
        r = hit(rows, 're32', k)
        print(f'  @{k:<2} 原始 {pct(o):18s} rerank {pct(r)}   ({r - o:+d} 题)')

    print(f'\n=== B. 产品口径（候选 {PRODUCT_POOL} → 注入 {PRODUCT_INJECT}）===')
    o = hit(rows, 'orig15', PRODUCT_INJECT)
    r = hit(rows, 're15', PRODUCT_INJECT)
    print(f'  @{PRODUCT_INJECT} 原始 {pct(o):18s} rerank {pct(r)}   ({r - o:+d} 题)')
    for k in (8, 15):
        o2 = hit(rows, 'orig15', k)
        r2 = hit(rows, 're15', k)
        print(f'  @{k:<2}（池内全收）原始 {pct(o2):18s} rerank {pct(r2)}   ({r2 - o2:+d} 题)')

    only_o = sum(1 for r in rows if 0 < r['orig15'] <= PRODUCT_INJECT and not (0 < r['re15'] <= PRODUCT_INJECT))
    only_r = sum(1 for r in rows if not (0 < r['orig15'] <= PRODUCT_INJECT) and 0 < r['re15'] <= PRODUCT_INJECT)
    from math import comb
    tot = only_o + only_r
    p = 1.0 if tot == 0 else min(1.0, 2 * sum(comb(tot, i) for i in range(max(only_o, only_r), tot + 1)) / 2 ** tot)
    print(f'  配对：只原 {only_o} / 只 rerank {only_r}，McNemar p = {p:.4f}')

    print('\n分型 @5（产品口径）')
    for t in sorted({r['type'] for r in rows}):
        sub = [r for r in rows if r['type'] == t]
        o3 = sum(1 for r in sub if 0 < r['orig15'] <= PRODUCT_INJECT)
        r3 = sum(1 for r in sub if 0 < r['re15'] <= PRODUCT_INJECT)
        print(f'  {t:28s} n={len(sub):3d}  {o3 / len(sub) * 100:5.1f}% → {r3 / len(sub) * 100:5.1f}%')


if __name__ == '__main__':
    main()
