"""reranker 对照：同一批 32 条候选，按 CrossEncoder 分数重排后 @8 的变化。

判据：若 reranker 有效，@8 应从原始名次（33.9% 那档）明显上升；
若几乎不动，说明缺口不在排序而在索引粒度（k 曲线：40.7% 的题前 64 无 gold）。

用法：python probe-rerank.py [model]
  默认用本地缓存的 BAAI/bge-reranker-base；也可试 cross-encoder/ms-marco-MiniLM-L-6-v2。
  离线（HF_HUB_OFFLINE=1），不联网。
"""
import json
import os
import sys
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from sentence_transformers import CrossEncoder  # noqa: E402

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'BAAI/bge-reranker-base'
DATA = 'C:/prts-benchmark/rerank-cands.json'
K = 8


def hit_rank(cands, golds):
    """候选列表里第一个命中 gold 的位置（1-based），没有则 -1。"""
    for i, c in enumerate(cands):
        if c['text'][:60] in golds:
            return i + 1
    return -1


def mcnemar(b, c):
    """双侧精确 McNemar。"""
    from math import comb
    n = b + c
    if n == 0:
        return 1.0
    k = max(b, c)
    tail = sum(comb(n, i) for i in range(k, n + 1))
    return min(1.0, 2 * tail / (2 ** n))


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    print(f'模型 {MODEL}，题数 {len(data)}')
    t0 = time.time()
    model = CrossEncoder(MODEL, max_length=512, device='cpu')
    print(f'加载 {time.time() - t0:.1f}s')

    rows = []
    t1 = time.time()
    for n, it in enumerate(data, 1):
        if not it['cands']:
            continue
        pairs = [(it['question'], c['text']) for c in it['cands']]
        scores = model.predict(pairs, batch_size=32, show_progress_bar=False)
        order = sorted(range(len(scores)), key=lambda i: -float(scores[i]))
        reranked = [it['cands'][i] for i in order]
        rows.append({
            'type': it['type'],
            'orig': hit_rank(it['cands'], it['golds']),
            'rerank': hit_rank(reranked, it['golds']),
        })
        if n % 50 == 0:
            print(f'  {n}/{len(data)}  {time.time() - t1:.0f}s', flush=True)
    print(f'推理完成 {time.time() - t1:.0f}s（{(time.time() - t1) / max(1, len(rows)):.2f}s/题）')

    total = len(rows)
    orig_hit = sum(1 for r in rows if 0 < r['orig'] <= K)
    new_hit = sum(1 for r in rows if 0 < r['rerank'] <= K)
    both = sum(1 for r in rows if 0 < r['orig'] <= K and 0 < r['rerank'] <= K)
    only_orig = sum(1 for r in rows if 0 < r['orig'] <= K and not (0 < r['rerank'] <= K))
    only_new = sum(1 for r in rows if not (0 < r['orig'] <= K) and 0 < r['rerank'] <= K)
    neither = total - both - only_orig - only_new

    print(f'\n=== @{K}（{total} 题，候选池 32）===')
    print(f'  原始融合排序   {orig_hit}/{total} = {orig_hit / total * 100:.1f}%')
    print(f'  rerank 后      {new_hit}/{total} = {new_hit / total * 100:.1f}%')
    print(f'  配对：都中 {both} | 只原 {only_orig} | 只新 {only_new} | 都无 {neither}')
    print(f'  McNemar p = {mcnemar(only_orig, only_new):.4f}')

    # 天花板上限：候选池里有没有 gold
    in_pool = sum(1 for r in rows if r['orig'] > 0)
    print(f'\n候选池内存在 gold 的题：{in_pool}/{total} = {in_pool / total * 100:.1f}%（rerank 的理论上限）')
    if in_pool > 0:
        recovered = sum(1 for r in rows if r['orig'] > K and 0 < r['rerank'] <= K)
        print(f'原本在池内但排不进前 {K}、被 rerank 救回的题：{recovered}/{in_pool - orig_hit}')

    types = sorted({r['type'] for r in rows})
    print('\n分型 @8：原始 → rerank')
    for t in types:
        sub = [r for r in rows if r['type'] == t]
        o = sum(1 for r in sub if 0 < r['orig'] <= K)
        n2 = sum(1 for r in sub if 0 < r['rerank'] <= K)
        print(f'  {t:28s} n={len(sub):3d}  {o / len(sub) * 100:5.1f}% → {n2 / len(sub) * 100:5.1f}%')


if __name__ == '__main__':
    main()
