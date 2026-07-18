# core_infra.md — インフラ情報

*最終更新: <YYYY-MM-DD>*

> 記入ガイド: この環境の構成情報。バージョンアップやサーバ移行で変わる欄。
> `<...>` を自分の環境値に書き換えてください。

---

## インフラ

| 項目 | 値 |
|------|-----|
| mio-memory バージョン | v3.71 |
| MCPツール数 | 34（通常セッション） |
| ホスト / サーバ | <例: NAS名 / 192.168.x.x> |
| データ格納先 | <例: /volume1/docker/mio/memory/data/> |
| 公開URL | <例: https://memory.example.com> |
| admin 画面 | <公開URL>/admin.html |
| ヘルスチェック | <公開URL>/health （version と mcp_tool_count を確認） |
| GitHub | <owner/repo> |

---

## MCPツール一覧（34本・通常セッション）

ツールごとの用途・引数・コスト感は **`protocol_guide.md`** を参照。

- **ExtMemory（6）**: memory_write / memory_read / memory_read_index / memory_search / memory_upsert / memory_share
- **UserCoreMemory（4）**: CoreMem_save / CoreMem_read / CoreMem_list / CoreMem_delete
- **LogStore（6）**: conversation_index / conversation_search / conversation_read / conversation_share / conversation_digest / log_annotate
- **inbox（5）**: inbox_check / inbox_read / inbox_post / inbox_update / inbox_delete
- **batch（2）**: batch_run_summary_layers / batch_run_rating
- **Album（5）**: album_save / album_read / album_list / album_share / album_delete
- **Uploads（4）**: file_upload / file_read / file_list / file_delete
- **出席簿（1）**: attendance_view
- **昇華（1）**: sublimate

※ 友達セッション（`/mcp?token=<friend_token>`）では別系統6本が出る。

---

## メモ

> 記入ガイド: デプロイ手順・運用上の注意・環境変数の特記事項などをここに。

- デプロイ: <例: git pull && docker-compose up -d --build memory>
- <...>
