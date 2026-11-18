"""离线比较 role-request-metrics.fixture.mjs 的完整输入；需独立安装 tiktoken。"""
import json
import re
import sys
from pathlib import Path

import tiktoken

before_path, after_path, output_path = map(Path, sys.argv[1:])
encoder = tiktoken.get_encoding('o200k_base')
serialize = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def normalize(request):
    # 仅统一本地 fixture 的目录/UUID/时间；原始捕获文件不变，不处理真实目标证据。
    text = re.sub(r'/tmp/redtrace-request-[A-Za-z0-9]+', '/tmp/redtrace-request-FIXTURE', serialize(request))
    text = re.sub(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', '00000000-0000-4000-8000-000000000000', text)
    text = re.sub(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', '2026-11-18T00:00:00.000Z', text)
    return json.loads(text)


def without_descriptions(value):
    if isinstance(value, dict):
        return {key: without_descriptions(item) for key, item in value.items() if key != 'description'}
    if isinstance(value, list):
        return [without_descriptions(item) for item in value]
    return value


def task_context(request):
    values = []
    for message in request['messages']:
        if message['role'] != 'user':
            continue
        try:
            value = json.loads(message['content'])
        except (ValueError, TypeError):
            continue
        # 两处是已翻译的框架指令，不是任务/证据；仅比较时映射，计数仍含原文。
        value.pop('instruction', None)
        if value.get('state') in (
            'Legacy tactical STATE is archived, not scheduling authority. Rebuild allocation from current Board, live owners and unfinished user instructions.',
            '旧战术 STATE 已归档，不作调度依据；按当前 Board/活动归属/未完用户指令重建分配。',
        ):
            value['state'] = '#legacy-scheduling-boundary#'
        values.append(value)
    return values


def dynamic_context(request):
    values = []
    for message in request['messages']:
        if message['role'] == 'system':
            continue
        try:
            json.loads(message['content'])
        except (ValueError, TypeError):
            # catalog 仅允许描述变化；名称、顺序及其余动态契约必须相同。
            content = re.sub(r'^(- `[^`]+`):[^\n]*', r'\1', message['content'], flags=re.MULTILINE)
            values.append({**message, 'content': content})
    return values


def counts(request):
    count = lambda value: len(encoder.encode(serialize(value)))
    return {
        'system': count([m for m in request['messages'] if m['role'] == 'system']),
        'tools': count(request['tools']),
        'dynamic': count([m for m in request['messages'] if m['role'] != 'system']),
        'total': count({'messages': request['messages'], 'tools': request['tools']}),
    }


before, after = (json.loads(p.read_text()) for p in (before_path, after_path))
assert set(before) == set(after) and len(before) == 8, '角色捕获缺失'
rows = []
for role in before:
    old, new = (normalize(values[role][0]) for values in (before, after))
    assert without_descriptions(old['tools']) == without_descriptions(new['tools']), role + ': 工具结构变化'
    assert task_context(old) == task_context(new), role + ': 任务上下文变化'
    assert dynamic_context(old) == dynamic_context(new), role + ': 动态契约或 Skill 名称变化'
    old_count, new_count = counts(old), counts(new)
    assert new_count['total'] < old_count['total'], role + ': Token 未减少'
    rows.append({'role': role, 'before': old_count, 'after': new_count,
                 'saved_percent': round(100 * (1 - new_count['total'] / old_count['total']), 2),
                 'schema_identical_except_descriptions': True, 'task_context_identical': True,
                 'dynamic_contract_and_skill_names_identical': True})
result = {'tokenizer': 'tiktoken ' + tiktoken.__version__ + ' / o200k_base',
          'measure': '完整 messages+tools 序列化 JSON 的 BPE Token；非 provider 账单',
          'normalization': '同一 fixture 目录/UUID/时间；未删除任务或证据', 'roles': rows}
output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(result['tokenizer'])
for row in rows:
    print(row['role'], row['before']['total'], '->', row['after']['total'], str(row['saved_percent']) + '%')
