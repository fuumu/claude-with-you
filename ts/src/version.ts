/**
 * サーバーバージョン（正本）。/health の version・全ツール応答の server_version・
 * initialize / server/discover の serverInfo.version（`${VERSION}.0`）に使う。
 * v4.0 で TypeScript 単体になった（Python 版は legacy-python ブランチ）。
 */
export const VERSION = '4.0';
