#!/usr/bin/env python3
"""LongMemEval QA 判分（DeepSeek 版）。

原脚本 `src/evaluation/evaluate_qa.py` 用 OpenAI gpt-4o 做 LLM 判分。
PRTS 的运行时模型是 DeepSeek，博士 2026-11-01 决定判分也改用 DeepSeek。

但这引入「自己判自己」的偏差。本脚本的处理：

1. **判分模型默认 `deepseek-reasoner`**，与被测的 `deepseek-chat` 不同。
   同供应商、不同模型，偏差比同模型小，但不为零。
2. **输出每条记录 `judged_by`**。基线数字必须带着它一起引用——
   「V1-17 基线 0.72（judged_by=deepseek-reasoner）」才是完整的陈述。
3. **`--sample` 控制题数，`--dry-run` 只打印 prompt 不花钱。**
4. **判分 prompt 模板逐字取自原脚本，一个字不改。** 改了就没法与论文数字比较。

已知偏差（诚实记录，不假装没有）：
- 同供应商模型对自家输出的风格偏好可能存在，方向未知、幅度未知。
- 缓解手段只有两条：换模型（本脚本用 reasoner）、人工抽样复核（需人工）。
- 本脚本**不能**消除偏差，只能让它可追溯。

依赖：仅 Python 标准库。`openai` / `backoff` / `tqdm` / `numpy` 都不需要。

用法：
    export DEEPSEEK_API_KEY=$(cat C:/prts-data/secrets/deepseek.key)
    python scripts/eval-longmemeval.py --hyp hyp.jsonl --ref longmemeval_oracle.json
    python scripts/eval-longmemeval.py --hyp hyp.jsonl --ref ref.json --sample 5
    python scripts/eval-longmemeval.py --hyp hyp.jsonl --ref ref.json --dry-run
"""

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get('DEEPSEEK_API_BASE', 'https://api.deepseek.com/v1')
DEFAULT_MODEL = 'deepseek-reasoner'


# ---------------------------------------------------------------------------
# 判分 prompt 模板：逐字取自 LongMemEval 的 src/evaluation/evaluate_qa.py
# 改动任何一个字都会让基线不可与论文比较，因此这里保持原样。
# ---------------------------------------------------------------------------
def get_anscheck_prompt(task, question, answer, response, abstention=False):
    if not abstention:
        if task in ['single-session-user', 'single-session-assistant', 'multi-session']:
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'temporal-reasoning':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'knowledge-update':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'single-session-preference':
            template = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        else:
            raise NotImplementedError(task)
    else:
        template = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only."
        prompt = template.format(question, answer, response)
    return prompt


# ---------------------------------------------------------------------------
# API 调用：标准库直连，指数退避重试
# ---------------------------------------------------------------------------
def call_judge(prompt, model, api_key, max_retries=5):
    payload = json.dumps({
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'n': 1,
        'temperature': 0,
        'max_tokens': 1024,   # reasoner 的 reasoning token 也占额度，给宽一点
    }).encode('utf-8')

    last_err = None
    for attempt in range(max_retries):
        req = urllib.request.Request(
            f'{API_BASE}/chat/completions',
            data=payload,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}',
            },
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode('utf-8'))
            return body['choices'][0]['message']['content']
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:300]
            last_err = f'HTTP {e.code}: {detail}'
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(last_err) from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = f'network: {e}'
            time.sleep(2 ** attempt)
            continue
    raise RuntimeError(f'重试 {max_retries} 次仍失败: {last_err}')


def load_json_or_jsonl(path):
    with open(path, encoding='utf-8') as f:
        raw = f.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return [json.loads(line) for line in raw.splitlines() if line.strip()]


def main():
    ap = argparse.ArgumentParser(description='LongMemEval QA 判分（DeepSeek 版）')
    ap.add_argument('--hyp', required=True, help='被测系统的输出 jsonl，每行 {question_id, hypothesis}')
    ap.add_argument('--ref', required=True, help='LongMemEval 参考数据（json 数组或 jsonl）')
    ap.add_argument('--model', default=DEFAULT_MODEL, help=f'判分模型，默认 {DEFAULT_MODEL}')
    ap.add_argument('--sample', type=int, default=0, help='只跑前 N 题（0 = 全部）')
    ap.add_argument('--seed', type=int, default=42, help='抽样随机种子')
    ap.add_argument('--dry-run', action='store_true', help='只打印 prompt，不调 API')
    ap.add_argument('--out', default=None, help='结果文件，默认 <hyp>.eval-results-<model>')
    args = ap.parse_args()

    api_key = os.environ.get('DEEPSEEK_API_KEY')
    if not api_key and not args.dry_run:
        print('错误：需要环境变量 DEEPSEEK_API_KEY（--dry-run 不需要）', file=sys.stderr)
        return 2

    hypotheses = load_json_or_jsonl(args.hyp)
    references = load_json_or_jsonl(args.ref)
    qid2qdata = {e['question_id']: e for e in references}

    if args.sample > 0:
        rng = random.Random(args.seed)
        hypotheses = rng.sample(hypotheses, min(args.sample, len(hypotheses)))

    out_path = args.out or f'{args.hyp}.eval-results-{args.model}'
    logs = []
    qtype2acc = {}

    for i, entry in enumerate(hypotheses, 1):
        qid = entry['question_id']
        if qid not in qid2qdata:
            print(f'警告：跳过 {qid}（参考数据里没有）', file=sys.stderr)
            continue

        ref = qid2qdata[qid]
        # question_type 字段是 LongMemEval 的原始字段；缺失时退化为 unknown
        qtype = ref.get('question_type', 'unknown')
        prompt = get_anscheck_prompt(
            qtype, ref['question'], ref['answer'], entry['hypothesis'],
            abstention='_abs' in qid,
        )

        if args.dry_run:
            print(f'--- [{i}/{len(hypotheses)}] {qid} (type={qtype}, abstention={"_abs" in qid}) ---')
            print(prompt[:400] + ('...' if len(prompt) > 400 else ''))
            print()
            continue

        text = call_judge(prompt, args.model, api_key)
        label = 'yes' in text.strip().lower()

        entry['autoeval_label'] = {'model': args.model, 'label': label}
        logs.append(entry)
        qtype2acc.setdefault(qtype, []).append(1 if label else 0)
        print(f'[{i}/{len(hypotheses)}] {qid} type={qtype} -> {"YES" if label else "no"}', flush=True)

    if args.dry_run:
        print(f'dry-run 完成：{len(hypotheses)} 题，未调用 API。')
        return 0

    with open(out_path, 'w', encoding='utf-8') as f:
        for e in logs:
            print(json.dumps(e, ensure_ascii=False), file=f)

    if logs:
        total = sum(1 for e in logs if e['autoeval_label']['label']) / len(logs)
        print(f'\nAccuracy: {total:.4f}  (judged_by={args.model}, n={len(logs)})')
        for k, v in sorted(qtype2acc.items()):
            print(f'\t{k}: {sum(v)/len(v):.4f} ({len(v)})')
    print(f'Saved to {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
