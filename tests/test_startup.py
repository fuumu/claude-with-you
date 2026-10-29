# -*- coding: utf-8 -*-
"""起動時処理の契約: 新規環境の CoreMem シード・「困ったら聞いて」の常駐 inbox・旧形式アップロードメタの退避。

共有の server フィクスチャは MIO_SEED_WELCOME=off で起動済みの環境を使い回すため、
ここではテストごとに専用のデータディレクトリでサーバーを起動する（旧 main.py の起動処理と同じ契約）。
"""
import json
import os
import shutil
import subprocess
import tempfile

import pytest

from conftest import REPO_ROOT, TEST_TOKEN, Server, _ensure_ts_built, _free_port, _wait_health

SKELETON = os.path.join(REPO_ROOT, 'ts', 'skeleton', 'coremem')
WELCOME_JA = '【ようこそ】mio-memory をセットアップしました'
WELCOME_EN = '[Welcome] mio-memory is set up'


@pytest.fixture()
def boot():
    """boot(data_root=None, **env) で専用サーバーを起動する。同じ data_root を渡せば再起動になる"""
    procs, dirs = [], []

    def _boot(data_root=None, **env_over):
        if data_root is None:
            data_root = tempfile.mkdtemp(prefix='mio-startup-')
            dirs.append(data_root)
        port = _free_port()
        base_url = f'http://127.0.0.1:{port}'
        env = {k: v for k, v in os.environ.items() if k not in ('MIO_SEED_LANG', 'MIO_SEED_WELCOME')}
        env.update({
            'MIO_PORT': str(port),
            'MIO_BIND': '127.0.0.1',
            'MIO_DATA_ROOT': data_root,
            'MIO_API_TOKEN': TEST_TOKEN,
            'MIO_BASE_URL': base_url,
            'MIO_LOG_LEVEL': 'off',
            'MIO_NIGHTLY_BATCH_HOUR': 'off',
            'LLM_ENDPOINTS': '127.0.0.1:1',
            'ANTHROPIC_API_KEY': '',
            'SENDGRID_API_KEY': '',
        })
        env.update(env_over)
        proc = subprocess.Popen(['node', _ensure_ts_built()], env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, cwd=os.path.join(REPO_ROOT, 'ts'))
        procs.append(proc)
        _wait_health(base_url, proc)
        return Server(base_url, TEST_TOKEN, data_root, proc)

    yield _boot
    for p in procs:
        p.kill()
        p.wait(timeout=10)
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)


def _core_files(server):
    return {f['name']: f for f in server.tool('CoreMem_list', {})['data']}


def _welcome(server):
    return [m for m in server.tool('inbox_check', {'to': 'chat'})['persistent'] if m['id'].endswith('_welcome')]


def _skeleton_md(lang):
    return sorted(f for f in os.listdir(os.path.join(SKELETON, lang)) if f.endswith('.md'))


def _skeleton_text(lang, name):
    with open(os.path.join(SKELETON, lang, name), encoding='utf-8') as f:
        return f.read()


def test_fresh_environment_gets_skeleton_and_welcome(boot):
    """新規環境: ja スケルトン一式（welcome.md 含む）が版 1 で入り、常駐の welcome inbox が 1 本だけ入る"""
    s = boot()
    files = _core_files(s)
    assert set(_skeleton_md('ja')) <= set(files)
    assert all(files[n]['version'] == 1 for n in _skeleton_md('ja'))
    got = s.tool('CoreMem_read', {'name': 'protocol_guide.md', 'refer_only': True})['content']
    assert got == _skeleton_text('ja', 'protocol_guide.md')
    w = _welcome(s)
    assert [m['title'] for m in w] == [WELCOME_JA]
    assert 'CoreMem_read("welcome.md")' in w[0]['body']


def test_restart_does_not_seed_again(boot):
    """2 回目の起動では何も足さない（core_stable.md があれば既存環境として扱う）"""
    first = boot()
    first.proc.kill()
    first.proc.wait(timeout=10)
    again = boot(first.data_root)
    assert len(_welcome(again)) == 1
    files = _core_files(again)
    assert all(files[n]['version'] == 1 for n in _skeleton_md('ja'))


def test_seed_lang_en_and_unknown_falls_back_to_ja(boot):
    """MIO_SEED_LANG=en は英語スケルトン、存在しない言語は ja にフォールバック"""
    en = boot(MIO_SEED_LANG='en')
    assert en.tool('CoreMem_read', {'name': 'core_stable.md', 'refer_only': True})['content'] == \
        _skeleton_text('en', 'core_stable.md')
    assert [m['title'] for m in _welcome(en)] == [WELCOME_EN]
    xx = boot(MIO_SEED_LANG='xx')
    assert xx.tool('CoreMem_read', {'name': 'core_stable.md', 'refer_only': True})['content'] == \
        _skeleton_text('ja', 'core_stable.md')
    assert [m['title'] for m in _welcome(xx)] == [WELCOME_JA]


def test_seed_welcome_off(boot):
    """MIO_SEED_WELCOME=off なら welcome.md も常駐 inbox も入れない（ほかのスケルトンは入る）"""
    s = boot(MIO_SEED_WELCOME='off')
    files = _core_files(s)
    assert 'core_stable.md' in files and 'welcome.md' not in files
    assert _welcome(s) == []


def test_existing_environment_is_left_alone(boot, tmp_path):
    """core_stable.md が既にある環境にはスケルトンも welcome inbox も入れない"""
    root = tmp_path / 'data'
    (root / 'artifacts').mkdir(parents=True)
    (root / 'artifacts' / 'core_stable.md').write_text('# 既存の核', encoding='utf-8')
    s = boot(str(root))
    assert 'protocol_guide.md' not in _core_files(s)
    assert _welcome(s) == []
    assert (root / 'artifacts' / 'core_stable.md').read_text(encoding='utf-8') == '# 既存の核'


def test_legacy_upload_meta_is_migrated_at_startup(boot, tmp_path):
    """旧形式のアップロードメタ（{id}.json）は起動時に {id}.meta.json へ退避される（参照を待たない）"""
    up = tmp_path / 'data' / 'uploads'
    up.mkdir(parents=True)
    uid = '20260101_000000_boot_legacy'
    (up / f'{uid}.txt').write_text('起動時退避', encoding='utf-8')
    meta = {'id': uid, 'filename': 'boot_legacy.txt', 'mimetype': 'text/plain', 'size': 15,
            'ext': 'txt', 'comment': '', 'tags': [], 'uploaded_at': '2026-01-01T00:00:00'}
    (up / f'{uid}.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
    boot(str(tmp_path / 'data'))
    assert (up / f'{uid}.meta.json').exists()
    assert not (up / f'{uid}.json').exists()
