/**
 * サーバーバージョン（正本）。/health の version・全ツール応答の server_version・
 * initialize / server/discover の serverInfo.version（`${VERSION}.0`）に使う。
 * TS-FULL ステップ1 で Python /health からの取得をやめ、TS 側で自前管理にした。
 */
export const VERSION = '3.99';
