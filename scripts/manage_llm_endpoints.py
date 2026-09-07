#!/usr/bin/env python3
"""
manage_llm_endpoints.py — .env の LLM_ENDPOINTS / LLM_OK_MODELS を対話的に更新する

各エンドポイントに /v1/models を叩いてアクティブなモデルを表示し、
追加/削除を選択式で行い、結果を .env に書き戻す。
"""

import os
import sys
import json
import urllib.request
import urllib.error
import re

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
ENV_FILE = os.path.join(PROJECT_DIR, '.env')

DEFAULT_ENDPOINTS = ['192.168.10.32:1234', '192.168.10.32:1919']
DEFAULT_OK_MODELS = ['google/gemma-4-26b-a4b', 'google/gemma-4-e4b', 'Qwen3.6-35B-A3B-NVFP4']
CONNECT_TIMEOUT = 3


def load_env():
    """既存 .env を読み込む。返値: (行リスト, 現在値dict)"""
    lines = []
    values = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding='utf-8') as f:
            lines = f.readlines()
        for line in lines:
            m = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
            if m:
                values[m.group(1)] = m.group(2)
    return lines, values


def save_env(lines, updates):
    """既存の .env 行リストに updates を適用して書き戻す。
    既存行のある変数は上書き、ない変数は末尾追記。"""
    updated_keys = set()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        m = re.match(r'^([A-Z_]+)=', stripped)
        if m and m.group(1) in updates:
            key = m.group(1)
            new_lines.append(f'{key}={updates[key]}\n')
            updated_keys.add(key)
        else:
            new_lines.append(line if line.endswith('\n') else line + '\n')

    for key, val in updates.items():
        if key not in updated_keys:
            new_lines.append(f'{key}={val}\n')

    with open(ENV_FILE, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)


def discover_models(endpoint):
    """エンドポイントの /v1/models からモデル一覧を取得する"""
    base = f'http://{endpoint}' if not endpoint.startswith('http') else endpoint
    try:
        req = urllib.request.Request(f'{base}/v1/models')
        with urllib.request.urlopen(req, timeout=CONNECT_TIMEOUT) as resp:
            data = json.loads(resp.read())
        models = []
        for m in data.get('data', data.get('models', [])):
            mid = m.get('id', m.get('key', ''))
            if mid:
                models.append(mid)
        return models
    except Exception as e:
        return None


def print_header(text):
    print(f'\n{"=" * 60}')
    print(f'  {text}')
    print(f'{"=" * 60}')


def print_list(items, prefix='  '):
    for i, item in enumerate(items, 1):
        print(f'{prefix}{i}. {item}')


def prompt_choice(prompt_text, max_val, allow_empty=True):
    """番号選択。カンマ区切りで複数可。空Enter=スキップ。"""
    while True:
        raw = input(prompt_text).strip()
        if not raw:
            if allow_empty:
                return []
            print('  入力してください')
            continue
        try:
            nums = [int(x.strip()) for x in raw.split(',')]
            if all(1 <= n <= max_val for n in nums):
                return nums
            print(f'  1〜{max_val} の範囲で入力してください')
        except ValueError:
            print('  数字をカンマ区切りで入力してください')


def main():
    print_header('LLM エンドポイント管理ツール')

    lines, current = load_env()

    ep_str = current.get('LLM_ENDPOINTS', '')
    current_endpoints = [e.strip() for e in ep_str.split(',') if e.strip()] if ep_str else []
    ok_str = current.get('LLM_OK_MODELS', '')
    current_models = [m.strip() for m in ok_str.split(',') if m.strip()] if ok_str else []

    print(f'\n現在の .env 設定:')
    print(f'  LLM_ENDPOINTS = {", ".join(current_endpoints) if current_endpoints else "(未設定)"}')
    print(f'  LLM_OK_MODELS = {", ".join(current_models) if current_models else "(未設定)"}')

    # --- エンドポイント管理 ---
    print_header('エンドポイント管理')

    working_endpoints = list(current_endpoints) if current_endpoints else list(DEFAULT_ENDPOINTS)
    print(f'\n現在のエンドポイント:')
    print_list(working_endpoints)

    print(f'\n各エンドポイントのモデル情報を取得中...')
    all_discovered = {}
    for ep in working_endpoints:
        models = discover_models(ep)
        all_discovered[ep] = models
        if models is None:
            print(f'  {ep} : 接続失敗')
        elif not models:
            print(f'  {ep} : アクティブモデルなし')
        else:
            print(f'  {ep} : {", ".join(models)}')

    # エンドポイント追加
    print(f'\nエンドポイントを追加しますか？ (host:port を入力、空Enter=スキップ)')
    while True:
        new_ep = input('  追加> ').strip()
        if not new_ep:
            break
        if new_ep not in working_endpoints:
            models = discover_models(new_ep)
            if models is None:
                print(f'    接続失敗。それでも追加しますか？ (y/N)')
                if input('    ').strip().lower() != 'y':
                    continue
            else:
                print(f'    発見モデル: {", ".join(models) if models else "(なし)"}')
                all_discovered[new_ep] = models
            working_endpoints.append(new_ep)
            print(f'    追加しました: {new_ep}')
        else:
            print(f'    既に登録済みです')

    # エンドポイント削除
    if len(working_endpoints) > 1:
        print(f'\nエンドポイントを削除しますか？ 番号で指定 (カンマ区切り可、空Enter=スキップ)')
        print_list(working_endpoints)
        nums = prompt_choice('  削除> ', len(working_endpoints))
        for n in sorted(nums, reverse=True):
            removed = working_endpoints.pop(n - 1)
            print(f'    削除: {removed}')

    # --- モデル管理 ---
    print_header('使用可能モデル管理')

    all_models = set()
    for ep, models in all_discovered.items():
        if models:
            all_models.update(models)

    working_models = list(current_models) if current_models else list(DEFAULT_OK_MODELS)
    print(f'\n現在のOKモデルリスト:')
    print_list(working_models)

    # 発見済みで未登録のモデルを提案
    new_candidates = [m for m in sorted(all_models) if m not in working_models]
    if new_candidates:
        print(f'\n発見済みだがOKリストにないモデル:')
        print_list(new_candidates)
        print(f'追加する番号を選択 (カンマ区切り可、空Enter=スキップ)')
        nums = prompt_choice('  追加> ', len(new_candidates))
        for n in nums:
            model = new_candidates[n - 1]
            working_models.append(model)
            print(f'    追加: {model}')

    # モデル手動追加
    print(f'\nモデルを手動追加しますか？ (モデル名を入力、空Enter=スキップ)')
    while True:
        new_model = input('  追加> ').strip()
        if not new_model:
            break
        if new_model not in working_models:
            working_models.append(new_model)
            print(f'    追加: {new_model}')
        else:
            print(f'    既に登録済みです')

    # モデル削除
    if len(working_models) > 1:
        print(f'\nモデルを削除しますか？ 番号で指定 (カンマ区切り可、空Enter=スキップ)')
        print_list(working_models)
        nums = prompt_choice('  削除> ', len(working_models))
        for n in sorted(nums, reverse=True):
            removed = working_models.pop(n - 1)
            print(f'    削除: {removed}')

    # --- 確認・保存 ---
    print_header('確認')
    print(f'\n  LLM_ENDPOINTS = {",".join(working_endpoints)}')
    print(f'  LLM_OK_MODELS = {",".join(working_models)}')

    print(f'\nこの内容で .env を更新しますか？ (Y/n)')
    confirm = input('  ').strip().lower()
    if confirm in ('', 'y', 'yes'):
        updates = {
            'LLM_ENDPOINTS': ','.join(working_endpoints),
            'LLM_OK_MODELS': ','.join(working_models),
        }
        save_env(lines, updates)
        print(f'\n  .env を更新しました: {ENV_FILE}')
    else:
        print(f'\n  キャンセルしました')


if __name__ == '__main__':
    main()
