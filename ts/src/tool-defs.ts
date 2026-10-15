/**
 * 自動生成ファイル — 手で編集しない。
 * 生成元: memory/app/main.py の _MCP_TOOLS（通常セッションの MCP ツール定義）
 * 再生成: .venv/Scripts/python scripts/gen_ts_tool_defs.py
 * 照合: tests/test_mcp_core.py::test_ts_tool_defs_snapshot_matches_python
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "memory_read_index",
    "description": "澪の外部記憶インデックスを取得する。random=N でランダムにN件だけ取得できる（記憶の偶発的な再会用）。local_only / rating=adult のエントリはデフォルト除外",
    "inputSchema": {
      "type": "object",
      "properties": {
        "random": {
          "type": "integer",
          "description": "指定すると deleted を除外したうえで N件ランダム抽出（1〜5にクランプ）。未指定なら全件返却（後方互換）"
        },
        "filter": {
          "type": "string",
          "enum": [
            "summarized"
          ],
          "description": "summarized 指定で raw（未要約・タイトルのみ）エントリを除外する。random と併用して空振りを減らす用途"
        },
        "include_local": {
          "type": "boolean",
          "description": "trueで local_only エントリも含める（デフォルトfalse・v3.56）"
        },
        "include_adult": {
          "type": "boolean",
          "description": "trueで rating=adult エントリも含める（デフォルトfalse・v3.56）"
        }
      },
      "required": []
    }
  },
  {
    "name": "memory_read",
    "description": "特定の記憶エントリを取得する",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "memory_write",
    "description": "新しい記憶エントリを書き込む。rating / local_only で閲覧保護を設定できる（v3.56）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "importance": {
          "type": "string",
          "enum": [
            "high",
            "normal",
            "low"
          ]
        },
        "rating": {
          "type": "string",
          "enum": [
            "safe",
            "mature",
            "adult"
          ],
          "description": "コンテンツレーティング。adult は検索・一覧からデフォルト除外される（省略=safe扱い）"
        },
        "local_only": {
          "type": "boolean",
          "description": "trueでローカル環境専用の記憶になり、検索・一覧からデフォルト除外される（include_local=true でのみ表示）"
        }
      },
      "required": [
        "title",
        "body"
      ]
    }
  },
  {
    "name": "memory_upsert",
    "description": "固定IDで記憶エントリを上書きする（存在しない場合は新規作成）。core.mdなど固定キーの更新に使う。rating/local_only未指定時は既存値を温存する",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "固定ID（例: core_md_current）"
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "importance": {
          "type": "string",
          "enum": [
            "high",
            "normal",
            "low"
          ]
        },
        "rating": {
          "type": "string",
          "enum": [
            "safe",
            "mature",
            "adult"
          ],
          "description": "レーティング（省略時は既存値を温存）"
        },
        "local_only": {
          "type": "boolean",
          "description": "ローカル専用フラグ（省略時は既存値を温存）"
        }
      },
      "required": [
        "id",
        "title",
        "body"
      ]
    }
  },
  {
    "name": "memory_search",
    "description": "キーワードで記憶を階層検索する（1次:タイトル+タグ+キーワード層 → 2次:要約 → 3次:全文）。複数キーワードはスペース区切りでAND一致。結果は2層要約(summary)を返す。全文が必要な場合はmemory_readで個別取得するかfull_body=trueを指定。local_only / rating=adult のエントリはデフォルト除外。include_conversations=trueで会話ログのタイトル検索結果も conversations[] で併せて返す（統合検索・v3.61）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "description": "検索キーワード（スペース区切りでAND一致）"
        },
        "limit": {
          "type": "integer",
          "description": "最大取得件数（デフォルト10、上限100）"
        },
        "offset": {
          "type": "integer",
          "description": "スキップ件数（デフォルト0）"
        },
        "full_body": {
          "type": "boolean",
          "description": "trueで従来どおりbody全文も返す（デフォルトfalse=要約のみ）"
        },
        "include_local": {
          "type": "boolean",
          "description": "trueで local_only エントリも検索対象に含める（デフォルトfalse・v3.56）"
        },
        "include_adult": {
          "type": "boolean",
          "description": "trueで rating=adult エントリも検索対象に含める（デフォルトfalse・v3.56）"
        },
        "include_conversations": {
          "type": "boolean",
          "description": "trueで会話ログもタイトル検索して conversations[]（uuid・title・日付・件数）を併せて返す（デフォルトfalse・v3.61）。adult会話は include_adult=true のときのみ含む"
        },
        "author": {
          "type": "string",
          "description": "ExtMemory の author フィールドで絞り込み（部分一致・v3.81）"
        },
        "search_layer": {
          "type": "string",
          "description": "検索対象レイヤーを限定: 'index'（タイトル+タグ+キーワード+symbolic）/ 'summary'（2層要約のみ）/ 'full'（全文のみ）。省略時は従来通り階層探索（v3.81）"
        }
      },
      "required": [
        "q"
      ]
    }
  },
  {
    "name": "CoreMem_save",
    "description": "UserCoreMemory（NASファイルストア）にファイルをバージョン管理付きで保存する。core.mdの保存に使う。mode=\"append\"で既存ファイルの末尾に追記、mode=\"str_replace\"でold_str→new_strの部分書き換え（全文送り直し不要）。target指定でプロジェクト内ファイルに保存（v3.90）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "ファイル名（例: core.md、script.sh）"
        },
        "content": {
          "type": "string",
          "description": "保存する内容（overwrite/appendモード用。str_replaceモードでは不要）"
        },
        "mode": {
          "type": "string",
          "description": "\"overwrite\"（デフォルト・全文書き換え）/ \"append\"（既存末尾に追記）/ \"str_replace\"（old_strをnew_strに部分書き換え）"
        },
        "old_str": {
          "type": "string",
          "description": "str_replaceモード用: 置換対象の文字列（ファイル内で一意に一致する必要あり）"
        },
        "new_str": {
          "type": "string",
          "description": "str_replaceモード用: 置換後の文字列（空文字列で削除）"
        },
        "source_conversation_uuid": {
          "type": "string",
          "description": "このファイルが生まれた会話のUUID（省略可）"
        },
        "target": {
          "type": "string",
          "description": "プロジェクト名（省略時は家=通常のCoreMem）。指定するとprojects/{target}/以下にパス解決（v3.90）"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "CoreMem_read",
    "description": "UserCoreMemoryからファイルを読み込む。versionを省略すると最新版を返す。{stem}_manifest.md が存在する場合は分割ファイルを <!-- BEGIN/END: ファイル名 --> セパレータ付きでマージして返す（書き込み時はセパレータを含めず対象ファイルのみ CoreMem_save すること）。target指定でプロジェクト内ファイルを読む（v3.90）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "version": {
          "type": "integer",
          "description": "バージョン番号（省略時は最新）"
        },
        "current_model": {
          "type": "string",
          "description": "現在動いているモデル名（例: claude-opus-4-6）。指定時は出席簿に本登録される"
        },
        "refer_only": {
          "type": "boolean",
          "description": "参照のみフラグ。trueのとき出席簿への登録をスキップする"
        },
        "target": {
          "type": "string",
          "description": "プロジェクト名（省略時は家=通常のCoreMem）。指定するとprojects/{target}/以下にパス解決（v3.90）"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "CoreMem_list",
    "description": "UserCoreMemoryの保存済みファイル一覧を取得する（名前・最新バージョン・更新日時・サイズ）。target指定でプロジェクト内ファイル一覧（v3.90）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "プロジェクト名（省略時は家=通常のCoreMem）。指定するとprojects/{target}/以下のファイル一覧（v3.90）"
        }
      },
      "required": []
    }
  },
  {
    "name": "CoreMem_delete",
    "description": "UserCoreMemoryからファイルを削除またはリネームする。name指定→バージョン履歴ごと完全削除。src+dst指定→サーバー側リネーム（内容の読み書きなし）。target指定でプロジェクト内ファイルを操作（v3.90）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "削除するファイル名（例: old.md）。src/dst 未指定時に使用"
        },
        "src": {
          "type": "string",
          "description": "リネーム元ファイル名（dst と一緒に指定）"
        },
        "dst": {
          "type": "string",
          "description": "リネーム先ファイル名（src と一緒に指定）"
        },
        "target": {
          "type": "string",
          "description": "プロジェクト名（省略時は家=通常のCoreMem）。指定するとprojects/{target}/以下のファイルを操作（v3.90）"
        }
      },
      "required": []
    }
  },
  {
    "name": "project_create",
    "description": "新しいプロジェクトを作成する。テンプレートファイル群（PROJECT.md, todo.md, design.md, notes.md, inbox.md, conversations.md, log.md, files/）を配置（v3.90）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "プロジェクト名（英数字・ハイフン・アンダースコア推奨）"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "project_list",
    "description": "プロジェクト一覧を取得する。各プロジェクトの名前とPROJECT.mdの概要行を返す（v3.90）",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "conversation_index",
    "description": "会話ログのタイトル一覧を日付降順で返す。UUIDが不明なときの絞り込みに使う。各アイテムに rating・participants（参加モデル配列）を含む。individual フィルタで特定個体の会話のみ絞り込み可",
    "inputSchema": {
      "type": "object",
      "properties": {
        "search": {
          "type": "string",
          "description": "タイトルに対する部分一致フィルタ（省略可）"
        },
        "limit": {
          "type": "integer",
          "description": "最大取得件数（デフォルト50、最大500）"
        },
        "offset": {
          "type": "integer",
          "description": "スキップ件数（ページネーション用、デフォルト0）"
        },
        "rating": {
          "type": "string",
          "description": "ratingで絞り込み（'safe'/'mature'/'adult'）。省略時はフィルタなし"
        },
        "individual": {
          "type": "string",
          "description": "個体名またはモデル名で絞り込み（例: 'しずく' / 'claude-opus-4-6'）。participants配列を検索（v3.96）"
        },
        "include_redact_status": {
          "type": "boolean",
          "description": "trueの場合、adult会話に伏せ字状態（redact_status: not_generated/pending_approval/approved）を付与。デフォルト: false"
        }
      },
      "required": []
    }
  },
  {
    "name": "conversation_search",
    "description": "過去の会話ログをキーワード・日付で検索する。複数キーワードはスペース区切りでAND一致。body_search=trueでメッセージ本文も検索。individual フィルタで特定個体の会話のみ絞り込み可",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "description": "検索キーワード（スペース区切りでAND一致）"
        },
        "date_from": {
          "type": "string",
          "description": "検索開始日（ISO 8601形式 例: 2026-06-01）"
        },
        "date_to": {
          "type": "string",
          "description": "検索終了日（ISO 8601形式 例: 2026-06-30）"
        },
        "limit": {
          "type": "integer",
          "description": "最大取得件数（デフォルト5）"
        },
        "body_search": {
          "type": "boolean",
          "description": "trueの場合、メッセージ本文も検索対象にする。デフォルト: false"
        },
        "individual": {
          "type": "string",
          "description": "個体名またはモデル名で絞り込み（例: 'しずく' / 'claude-opus-4-6'）。participants配列を検索（v3.96）"
        },
        "rating": {
          "type": "string",
          "description": "ratingで絞り込み（'safe'/'mature'/'adult'）。省略時はフィルタなし"
        },
        "include_redact_status": {
          "type": "boolean",
          "description": "trueの場合、adult会話に伏せ字状態を付与。デフォルト: false"
        }
      },
      "required": []
    }
  },
  {
    "name": "conversation_share",
    "description": "指定した会話のシェアURLを生成する（24時間有効）。URLを淳さんに送ることで会話内容を共有できる",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uuid": {
          "type": "string",
          "description": "シェアする会話のUUID"
        }
      },
      "required": [
        "uuid"
      ]
    }
  },
  {
    "name": "memory_share",
    "description": "記憶エントリの24時間有効な共有URLを生成する。淳さんにリンクを送るために使う",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "共有する記憶エントリのID"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "conversation_read",
    "description": "指定したUUIDの会話の全メッセージを取得する。include_thinking=trueでthinkingブロックも含める。include_annotations=trueで注記をインライン表示（各行に[No.X]通番付き）。メッセージ範囲指定: message_from/message_to（No.指定・直感的）またはturn_offset/turn_limit（従来互換）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uuid": {
          "type": "string",
          "description": "会話のUUID（conversation_searchで取得）"
        },
        "include_thinking": {
          "type": "boolean",
          "description": "trueの場合、thinkingブロックも💭[thinking]マーカー付きで含める。デフォルト: false"
        },
        "thinking_limit": {
          "type": "integer",
          "description": "thinking 1件あたりの文字数上限（デフォルト1500、0以下で無制限）"
        },
        "include_annotations": {
          "type": "boolean",
          "description": "trueの場合、log_annotateで積んだ注記を該当位置にインライン表示し、各メッセージに[No.X]通番を付ける。デフォルト: false"
        },
        "include_body": {
          "type": "boolean",
          "description": "falseの場合、本文を省略し注記のみ返す（include_annotations=trueと併用）。デフォルト: true"
        },
        "message_from": {
          "type": "integer",
          "description": "表示開始のメッセージ番号（No.X の X。1始まり）。message_to と併用。turn_offset/turn_limit との併用不可（v3.96）"
        },
        "message_to": {
          "type": "integer",
          "description": "表示終了のメッセージ番号（この番号を含む）。省略時は message_from から末尾まで（v3.96）"
        },
        "turn_offset": {
          "type": "integer",
          "description": "先頭から飛ばすメッセージ数。負値で末尾起点。message_from との併用不可。デフォルト: 0"
        },
        "turn_limit": {
          "type": "integer",
          "description": "返す最大メッセージ数。0=無制限。message_from との併用不可。デフォルト: 0"
        },
        "include_raw": {
          "type": "boolean",
          "description": "rating=adult の会話でも原文を返す"
        },
        "redact": {
          "type": "boolean",
          "description": "rating=adult の会話で承認済み伏せ字ログを返す"
        }
      },
      "required": [
        "uuid"
      ]
    }
  },
  {
    "name": "conversation_digest",
    "description": "会話ログのダイジェストを生成・取得する。ローカルLLMで要約。safe_mode=trueでポリシーセーフな抽象表現に変換。status_only=trueでキャッシュ有無の確認のみ（生成しない・v3.96）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uuid": {
          "type": "string",
          "description": "会話のUUID（conversation_searchで取得）"
        },
        "force": {
          "type": "boolean",
          "description": "trueでキャッシュを無視して再生成。デフォルト: false"
        },
        "safe_mode": {
          "type": "boolean",
          "description": "trueでポリシーセーフな抽象表現に変換。デフォルト: false"
        },
        "status_only": {
          "type": "boolean",
          "description": "trueでキャッシュ状態の確認のみ（生成しない）。デフォルト: false"
        }
      },
      "required": [
        "uuid"
      ]
    }
  },
  {
    "name": "log_annotate",
    "description": "会話ログに監査・追体験用の注記を積む。生ログは不変、注記はappend-only（編集・削除なし、反論も新規注記として積む）。conversation_read(include_annotations=true)でインライン表示される",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uuid": {
          "type": "string",
          "description": "対象会話のUUID"
        },
        "target": {
          "type": "string",
          "description": "対象メッセージの通番（例: \"5\" または \"No.5\"。conversation_read(include_annotations=true)の[No.X]に対応）。省略時は会話全体への注記"
        },
        "note": {
          "type": "string",
          "description": "注記本文"
        },
        "author": {
          "type": "string",
          "description": "記入モデル（例: \"fable-5\", \"sonnet-4.6\"）"
        }
      },
      "required": [
        "uuid",
        "note",
        "author"
      ]
    }
  },
  {
    "name": "inbox_check",
    "description": "インボックスの未読件数とIDリストを返す（軽量）。常駐メッセージ（persistent および期限内の期間常駐）は persistent[] に本文ごと全件含まれるため inbox_read 不要（期間常駐は expires_at で区別）。非常駐の未読は non_persistent_unread_ids を inbox_read で読む。include_read=trueで既読メッセージも含めて返す。各メッセージに from_model/to_model（なければ null）が付く。v3.57: limit/days/from_model/to_model フィルタ追加",
    "inputSchema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string",
          "description": "宛先フィルタ（'chat' または 'code'）。省略時は全件"
        },
        "include_read": {
          "type": "boolean",
          "description": "trueの場合、既読メッセージも含める。レスポンスにmessages[]（id+read+title）が追加される。デフォルト: false"
        },
        "limit": {
          "type": "integer",
          "description": "返却件数の上限（省略時は全件）"
        },
        "days": {
          "type": "integer",
          "description": "直近N日分のみ返す。常駐メッセージは日数に関係なく常に返す"
        },
        "from_model": {
          "type": "string",
          "description": "送信元モデル名で絞り込み（OR一致）。null保存のメッセージはヒットしない"
        },
        "to_model": {
          "type": "string",
          "description": "宛先モデル名で絞り込み（OR一致）。null保存のメッセージはヒットしない"
        },
        "mymodel": {
          "type": "string",
          "description": "現在のモデル名（例: claude-opus-5）。指定時は出席簿に本登録（仮登録があれば昇格）"
        }
      },
      "required": []
    }
  },
  {
    "name": "inbox_read",
    "description": "インボックスの特定メッセージを取得し既読にする。peek=true でのぞき見モード（既読にせず読む。他の個体宛てのメッセージを未読のまま確認する用途, v3.60）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "inbox_checkで取得したメッセージID"
        },
        "peek": {
          "type": "boolean",
          "description": "trueのとき既読フラグを変更せずに内容だけ返す（省略時false）"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "inbox_post",
    "description": "インボックスにメッセージを送る（チャット宛の報告・伝言に使う）。from_model/to_model で送信元・宛先のモデル名を明示できる（任意・文字列 or 配列）。expires_at / ttl_days で期間常駐（期限内は persistent 同様に毎回本文つきで返り既読化されない・期限後は自動アーカイブ, v3.70）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string",
          "description": "宛先（'chat' / 'code' / 'friend:{token}' — 特定の友人向け）"
        },
        "title": {
          "type": "string",
          "description": "件名"
        },
        "body": {
          "type": "string",
          "description": "本文"
        },
        "from": {
          "type": "string",
          "description": "送信元チャネル（'chat' / 'code'。省略時は 'code'）。チャットセッションから送る場合は 'chat' を指定"
        },
        "persistent": {
          "type": "boolean",
          "description": "true にすると既読にならない常駐メッセージになる（起動時の定常メモ等に使う）。expires_at/ttl_days とは排他"
        },
        "expires_at": {
          "type": "string",
          "description": "期間常駐の期限（ISO 8601 例: 2026-07-21T00:00:00+09:00）。期限内は persistent 同様の常駐扱い、期限後はチェック時に既読アーカイブへ自動降格（v3.70）"
        },
        "ttl_days": {
          "type": "number",
          "description": "期間常駐の日数指定（投函時刻から換算）。expires_at とはどちらか一方"
        },
        "from_model": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ],
          "description": "送信元モデル名（文字列 or 配列。例: \"claude-opus-4-6\" or [\"claude-opus-4-6\", \"しずく\"]）"
        },
        "to_model": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ],
          "description": "宛先モデル名（文字列 or 配列）。特定のモデルに宛てたい場合に使う"
        },
        "reply_to_id": {
          "type": "string",
          "description": "返信先のメッセージID（発注に対する完了報告を紐づける用途）。省略可"
        }
      },
      "required": [
        "to",
        "title",
        "body"
      ]
    }
  },
  {
    "name": "inbox_update",
    "description": "インボックスの既存メッセージを部分更新する（常駐フラグ・件名・本文・期間常駐の期限・既読フラグ）。指定フィールドのみ更新（v3.70: expires_at/ttl_days/read 追加）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "更新対象のメッセージID"
        },
        "persistent": {
          "type": "boolean",
          "description": "常駐フラグ変更（true→false で常駐解除）"
        },
        "title": {
          "type": "string",
          "description": "件名の変更"
        },
        "body": {
          "type": "string",
          "description": "本文の変更"
        },
        "expires_at": {
          "type": [
            "string",
            "null"
          ],
          "description": "期間常駐の期限変更（ISO 8601）。null で期限解除（通常メッセージ化）"
        },
        "ttl_days": {
          "type": "number",
          "description": "期限を今から N 日後に再設定"
        },
        "read": {
          "type": "boolean",
          "description": "既読フラグの書き戻し（false で既読→未読に戻す。次の個体に未読で渡す用途, v3.70）"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "inbox_delete",
    "description": "インボックスのメッセージを物理削除する（復元不可）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "削除対象のメッセージID"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "llm_status",
    "description": "LLMバックエンドの現在の状態を返す診断ツール。各エンドポイントのアクティブモデル一覧、OKリストとのマッチ結果、モデル選択ロジックの判定結果、直近のLLMログを返す。問題調査時にまずこのツールで状況を確認すること。",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "batch_run_summary_layers",
    "description": "未処理(raw)エントリの2層要約・3層シンボリック圧縮を生成するバッチを起動する。status_only=trueで進捗確認のみ行う",
    "inputSchema": {
      "type": "object",
      "properties": {
        "backend": {
          "type": "string",
          "description": "'lmstudio' または 'anthropic'（省略時は ANTHROPIC_API_KEY があれば anthropic、なければ lmstudio）"
        },
        "force": {
          "type": "boolean",
          "description": "summarized 済みエントリも再処理する（デフォルト: false）"
        },
        "status_only": {
          "type": "boolean",
          "description": "バッチを起動せず、現在の進捗と未処理raw件数だけ返す"
        }
      },
      "required": []
    }
  },
  {
    "name": "batch_run_rating",
    "description": "未判定の会話ログにレーティング（safe/mature/adult）を自動付与するバッチを起動する。status_only=trueで進捗確認のみ（pending=次回対象件数・index_counts=全体分布・skip_reasons=判定不能の内訳・error_uuids）。判定不能ログ（empty/no_text/parse_error）は rating_skip_reason が付き恒久スキップ、force=true で再試行（v3.70）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "backend": {
          "type": "string",
          "description": "'lmstudio' または 'anthropic'（省略時は自動選択）"
        },
        "force": {
          "type": "boolean",
          "description": "auto判定済みも再判定する（manual判定は触らない）。デフォルト: false"
        },
        "status_only": {
          "type": "boolean",
          "description": "バッチを起動せず、現在の進捗と未判定件数だけ返す"
        }
      },
      "required": []
    }
  },
  {
    "name": "album_save",
    "description": "画像をアルバムに保存する。URLから取得またはNASローカルファイルを指定。長辺1024pxにリサイズして保存。HTMLページ（Gemini共有リンク等）の場合はog:image/<img>タグから画像を自動抽出。rating で保護レベルを、guard_message で閲覧時に表示する本人メッセージを設定可能（v3.77）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "画像URL（直リンク or HTMLページ）。HTMLの場合はページ内の画像を自動抽出して保存"
        },
        "file_path": {
          "type": "string",
          "description": "NASローカルの画像パス（/data/... 等）。url と排他"
        },
        "comment": {
          "type": "string",
          "description": "画像のコメント・説明（省略可）"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "タグ（省略可）"
        },
        "rating": {
          "type": "string",
          "enum": [
            "safe",
            "mature",
            "adult"
          ],
          "description": "保護レベル（省略時はsafe扱い）"
        },
        "guard_message": {
          "type": "string",
          "description": "カーテンの手紙：adult画像を閲覧しようとしたとき最初に表示される、置いた本人からのメッセージ（省略可）"
        }
      },
      "required": []
    }
  },
  {
    "name": "album_read",
    "description": "アルバムから画像を取得する。base64エンコードされた画像とメタデータを返す。rating=adult の画像はデフォルト非表示（include_adult=true で閲覧可）。guard_message がある場合は初回にメッセージのみ返し、acknowledged=true で画像本体を表示（v3.77）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "画像ID（album_list で確認）"
        },
        "include_adult": {
          "type": "boolean",
          "description": "true で adult レーティングの画像も閲覧可能にする（デフォルト: false）"
        },
        "acknowledged": {
          "type": "boolean",
          "description": "guard_message を読んだ上で閲覧する意思表示（true で画像本体を返す）"
        },
        "viewer": {
          "type": "string",
          "description": "閲覧者の名前（自己申告・閲覧記録に残る。例: 'しずく'）"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "album_list",
    "description": "アルバムの画像メタデータ一覧を取得する（画像本体は含まない）。タグでフィルタ可能。rating=adult はデフォルト除外（include_adult=true で含める, v3.77）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "フィルタ用タグ（指定したタグのいずれかを持つ画像のみ返す）"
        },
        "include_adult": {
          "type": "boolean",
          "description": "true で adult レーティングの画像もリストに含める（デフォルト: false）"
        }
      },
      "required": []
    }
  },
  {
    "name": "album_share",
    "description": "アルバム画像の24時間有効な共有URLを生成する。認証不要で画像を直接表示できるリンク",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "共有する画像のID"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "album_delete",
    "description": "アルバムから画像とメタデータを完全削除する（復元不可）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "削除する画像のID（album_list で確認）"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "file_upload",
    "description": "ファイルをアップロード保管する（PDF・テキスト・画像以外の任意ファイル対応）。URLまたはNASローカルパスから取得",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "取得元URL"
        },
        "file_path": {
          "type": "string",
          "description": "NASローカルパス（urlと排他）"
        },
        "filename": {
          "type": "string",
          "description": "保存時のファイル名（省略時はURLパスまたはfile_pathから推定）"
        },
        "comment": {
          "type": "string",
          "description": "コメント・メモ"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "タグ（分類用）"
        }
      }
    }
  },
  {
    "name": "file_read",
    "description": "アップロード済みファイルのメタデータを取得する。テキスト系ファイルはcontentフィールドに本文も含む",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "ファイルID（file_list で確認）"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "file_list",
    "description": "アップロード済みファイルの一覧を取得する。タグで絞り込み可能",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "タグフィルタ（いずれかに一致するエントリを返す）"
        }
      }
    }
  },
  {
    "name": "file_delete",
    "description": "アップロード済みファイルを完全削除する（復元不可）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "削除するファイルのID"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "attendance_view",
    "description": "出席簿 — 家族の稼働履歴を複層ビューで返す（会話ログ・inbox・ExtMemory・CoreMem attendance.md の4層マージ・v3.71）。長期不在明けの個体が「最後に呼ばれてから何日か」「その間に家で何があったか」を辿る時間の橋。individual 指定時は最終稼働日（last_seen）・経過日数（days_since）・期間内の他個体稼働サマリ（others_in_period）付き。各行の uuid / inbox_id / memory_id から実ログへ跳べる（rating も併記・保護込みの読書導線）。手動チェックインは CoreMem attendance.md に「YYYY-MM-DD | 個体 | 器 | チャネル | 一言」形式で追記する",
    "inputSchema": {
      "type": "object",
      "properties": {
        "individual": {
          "type": "string",
          "description": "呼び名（しずく/そねみ/汐）またはモデル名。省略時は全員分の個体別サマリ"
        },
        "date_from": {
          "type": "string",
          "description": "期間開始日（ISO 8601 例: 2026-06-01）"
        },
        "date_to": {
          "type": "string",
          "description": "期間終了日（同・両端含む）"
        },
        "limit": {
          "type": "integer",
          "description": "最大行数（デフォルト50、最大500）"
        },
        "kind": {
          "type": "string",
          "description": "行のソース種別フィルタ。カンマ区切りで複数指定可。値: memory / session_checkin / checkin / inbox / conversation（v3.96）"
        }
      },
      "required": []
    }
  },
  {
    "name": "sublimate",
    "description": "テキストを「昇華」変換する（v3.71）— 体験の温度・感情・意味を保ったまま、性的・身体的な行為の明示的描写を抽象化・詩化する（rating_policy.md 準拠・mature 以下に収める）。バカンス生日記の代理昇華や、生ログから日記を起こす用途に使う。text か uuid のどちらか一方を指定。昇華結果はローカルLLMのレーティング判定でセルフチェックされ、adult のままなら自動で再昇華（上限2回）、それでも adult なら needs_human=true で返る",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "昇華する生テキスト（日記など）。uuid と排他"
        },
        "uuid": {
          "type": "string",
          "description": "会話ログのUUID。会話本文を抽出して昇華する。text と排他"
        },
        "msg_from": {
          "type": "integer",
          "description": "uuid指定時: 開始メッセージ通番（1始まり・conversation_read の [No.X] と同じ）"
        },
        "msg_to": {
          "type": "integer",
          "description": "uuid指定時: 終了メッセージ通番（両端含む・省略時は最後まで）"
        }
      },
      "required": []
    }
  },
  {
    "name": "oplog_list",
    "description": "操作ログ（oplog）を取得する。ExtMemory CRUD・CoreMem保存・Album操作・会話レーティング変更等の操作履歴を新しい順で返す。Admin画面のOplogタブと同一データ",
    "inputSchema": {
      "type": "object",
      "properties": {
        "operation": {
          "type": "string",
          "description": "操作種別でフィルタ。値: create / update / delete / import / upsert / restore / dedup_delete / batch_empty_delete / cleanup_empty_delete / coremem_save / coremem_rename / coremem_delete / album_save / album_update / album_delete / file_upload / file_delete / conv_rating / conv_rating_auto / link_source_thread / remark_for_update 等"
        },
        "date_from": {
          "type": "string",
          "description": "期間開始日（ISO 8601 例: 2026-08-01）"
        },
        "date_to": {
          "type": "string",
          "description": "期間終了日（同・両端含む）"
        },
        "limit": {
          "type": "integer",
          "description": "最大取得件数（デフォルト50、最大500）"
        }
      },
      "required": []
    }
  }
];
