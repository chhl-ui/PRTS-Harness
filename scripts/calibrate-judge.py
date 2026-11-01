#!/usr/bin/env python3
"""判分器校准：生成有区分力的样本 → 判分 → 算混淆矩阵。

## 为什么需要它

首轮校准（`eval-longmemeval.py` 配手工造的 pos/neg）只证明了判分器能分开
「正确」与「完全离题」，区分力不足以支撑「判分器可信」。子代理审查指出：

- 负样本 24 条只有 6 个不同字符串，误差高度相关，有效样本量约 6；
- 负样本与题干零 token 共享，任务退化成「离题检测」而非「错误检测」；
- 正样本是标准答案逐字复制，恒答 yes 的桩判分器也能满分。

本脚本按批评重造：

| 变体 | 怎么造 | 应判 |
|---|---|---|
| `paraphrase` | 同义改写，同一事实不同措辞 | **yes** |
| `partial` | 提到正确主题但省略关键事实 | **no**（LongMemEval 原文：「only a subset → answer no」） |
| `nearmiss` | 数值差一位 / 实体换成同题干扰项 | **no** |
| `offtopic` | 流畅但完全在说别的事 | **no** |
| `abs-refuse` | abstention 题如实说不知道 | **yes** |
| `abs-fabricate` | abstention 题硬编一个答案 | **no** |

## 两个模型分工

生成用 `deepseek-chat`（快、便宜），判分用 `deepseek-reasoner`（与被测模型不同）。
生成质量本身是变量——如果 `nearmiss` 造得不够近，校准会高估判分器。
所以生成后要把变体原文打印出来人工扫一眼。

## 用法

    export DEEPSEEK_API_KEY=$(cat C:/prts-data/secrets/deepseek.key)
    python scripts/calibrate-judge.py --source gen-source.json --ref longmemeval_oracle.json
    python scripts/calibrate-judge.py ... --gen-only      # 只生成不判分
    python scripts/calibrate-judge.py ... --reuse calib2.jsonl   # 复用已生成样本

依赖：仅标准库。
"""

import argparse
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_judge_module():
    spec = importlib.util.spec_from_file_location(
        'lme_judge', os.path.join(HERE, 'eval-longmemeval.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


J = _load_judge_module()

GEN_MODEL = 'deepseek-chat'

GEN_PROMPT = """You are building a calibration set for an automated QA grader. Given a question and its gold answer, write exactly four candidate replies.

Rules:
- "paraphrase": correct, but phrased differently. Same fact, different words. Shorter is fine.
- "partial": names the right subject but omits the specific fact that answers the question. Plausible but incomplete.
- "nearmiss": nearly right but factually wrong. If the gold answer is a number, change it by one or a similar small amount. If it is an entity, substitute a different but plausible entity from the same category.
- "offtopic": fluent, natural, but about something else entirely.

Return JSON only, no markdown fence, no explanation:
{{"paraphrase": "...", "partial": "...", "nearmiss": "...", "offtopic": "..."}}

Question: {q}
Gold answer: {a}"""


def extract_json(text):
    if not text:
        return None
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def generate(api_key, items, reuse_path=None):
    """返回 [(question_id, hypothesis, variant, expected)]。"""
    rows = []
    if reuse_path and os.path.exists(reuse_path):
        with open(reuse_path, encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    rows.append(json.loads(line))
        sys.stderr.write(f'复用 {reuse_path}: {len(rows)} 条\n')
        return rows

    for i, it in enumerate(items, 1):
        qid = it['question_id']
        is_abs = qid.endswith('_abs')
        if is_abs:
            # abstention 题单独构造：正确拒答 vs 硬编
            q, a = it['question'], it['answer']
            rows.append({'question_id': qid, 'variant': 'abs-refuse', 'expected': True,
                         'hypothesis': "I don't have enough information in our conversation to answer that."})
            rows.append({'question_id': qid, 'variant': 'abs-fabricate', 'expected': False,
                         'hypothesis': f"It was {a[:60]}"})
            print(f'[{i}/{len(items)}] {qid} abs 双样本已造', flush=True)
            continue

        prompt = GEN_PROMPT.format(q=it['question'], a=it['answer'])
        try:
            text, fr = J.call_judge(prompt, GEN_MODEL, api_key)
        except Exception as e:
            sys.stderr.write(f'{qid} 生成失败: {e}\n')
            continue
        obj = extract_json(text)
        if not obj:
            sys.stderr.write(f'{qid} 生成结果无法解析: {(text or "")[:150]}\n')
            continue
        for variant, expected in (('paraphrase', True), ('partial', False),
                                  ('nearmiss', False), ('offtopic', False)):
            body = obj.get(variant)
            if isinstance(body, str) and body.strip():
                rows.append({'question_id': qid, 'variant': variant,
                             'expected': expected, 'hypothesis': body.strip()})
        print(f'[{i}/{len(items)}] {qid} 生成 4 条', flush=True)
    return rows


def judge(api_key, rows, qid2qdata):
    out = []
    for i, r in enumerate(rows, 1):
        qid = r['question_id']
        ref = qid2qdata.get(qid)
        if ref is None:
            sys.stderr.write(f'跳过 {qid}（ref 缺项）\n')
            continue
        qtype = ref.get('question_type', 'unknown')
        is_abs = qid.endswith('_abs')
        prompt = J.get_anscheck_prompt(qtype, ref['question'], ref['answer'],
                                       r['hypothesis'], abstention=is_abs)
        try:
            raw, fr = J.call_judge(prompt, J.DEFAULT_MODEL, api_key)
        except Exception as e:
            r['verdict'] = None
            r['error'] = f'{type(e).__name__}: {e}'
            out.append(r)
            continue
        r['verdict'] = J.parse_verdict(raw, fr)
        r['raw'] = (raw or '')[:300]
        r['finish_reason'] = fr
        out.append(r)
        arrow = {True: 'YES', False: 'no', None: 'INVALID'}[r['verdict']]
        print(f'[{i}/{len(rows)}] {qid} {r["variant"]:<14} -> {arrow}', flush=True)
    return out


def report(rows):
    print('\n=== 按变体分组（expected vs 实际）===')
    print(f'{"variant":<16}{"n":>4}{"expect":>8}{"yes":>6}{"no":>6}{"invalid":>9}{"正确率":>9}')
    by_variant = {}
    for r in rows:
        by_variant.setdefault(r['variant'], []).append(r)
    TP = FN = FP = TN = INV = 0
    for v, arr in sorted(by_variant.items()):
        yes = sum(1 for r in arr if r.get('verdict') is True)
        no = sum(1 for r in arr if r.get('verdict') is False)
        inv = sum(1 for r in arr if r.get('verdict') is None)
        exp = arr[0]['expected']
        correct = yes if exp else no
        valid = yes + no
        rate = correct / valid if valid else 0.0
        print(f'{v:<16}{len(arr):>4}{str(exp):>8}{yes:>6}{no:>6}{inv:>9}{rate:>9.3f}')
        # 混淆矩阵：expected=True 为正类
        if exp:
            TP += yes
            FN += no
        else:
            FP += yes
            TN += no
        INV += inv

    print('\n=== 混淆矩阵（正向 = 应判 yes）===')
    print(f'TP={TP}  FN={FN}  FP={FP}  TN={TN}  invalid={INV}')
    if TP + FN:
        print(f'召回率(sensitivity) = {TP/(TP+FN):.4f}   ← paraphrase/abs-refuse 被判对的比例')
    if FP + TN:
        print(f'特异度(specificity) = {TN/(FP+TN):.4f}   ← partial/nearmiss/offtopic/abs-fabricate 被判错的比例')
    if TP + FP:
        print(f'精确率(precision)   = {TP/(TP+FP):.4f}')
    total = TP + FN + FP + TN
    if total:
        print(f'真准确率           = {(TP+TN)/total:.4f}  (n={total})')

    print('\n=== 判错的明细（这是真正要看的东西）===')
    bad = [r for r in rows if r.get('verdict') is not None
           and r['verdict'] != r['expected']]
    if not bad:
        print('（无）')
    for r in bad:
        print(f'  {r["question_id"]} [{r["variant"]}] 应判 {r["expected"]}，实判 {r["verdict"]}')
        print(f'    hypothesis: {r["hypothesis"][:160]}')
        print(f'    judge raw : {r.get("raw","")[:160]}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True, help='题目源 json（含 question_id/question/answer）')
    ap.add_argument('--ref', required=True, help='LongMemEval 参考数据')
    ap.add_argument('--out', default='calib2.jsonl', help='生成的样本落盘')
    ap.add_argument('--gen-only', action='store_true')
    ap.add_argument('--reuse', default=None, help='复用已生成的样本文件')
    args = ap.parse_args()

    api_key = os.environ.get('DEEPSEEK_API_KEY')
    if not api_key:
        sys.stderr.write('错误：需要 DEEPSEEK_API_KEY\n')
        return 2

    items = J.load_json_or_jsonl(args.source)
    references = J.load_json_or_jsonl(args.ref)
    qid2qdata = {e['question_id']: e for e in references}

    rows = generate(api_key, items, args.reuse)
    with open(args.out, 'w', encoding='utf-8') as f:
        for r in rows:
            print(json.dumps(r, ensure_ascii=False), file=f)
    print(f'\n生成 {len(rows)} 条 → {args.out}')
    if args.gen_only:
        return 0

    judged = judge(api_key, rows, qid2qdata)
    with open(args.out.replace('.jsonl', '-judged.jsonl'), 'w', encoding='utf-8') as f:
        for r in judged:
            print(json.dumps(r, ensure_ascii=False), file=f)
    report(judged)
    return 0


if __name__ == '__main__':
    sys.exit(main())
