# DriveNotes（ドライブノート）

Google Drive に保存したノート（Evernote バックアップ・WebClips）を **Evernote のように閲覧** し、
スマホ・PC から **テキスト・写真・添付ファイルを1件のノートとして登録** するアプリ（PWA）です。
スマホ（iPhone / Android）と PC の Chrome に同じアプリをインストールして使います。

## できること

| 機能 | 内容 |
|---|---|
| 閲覧 | ノートブック一覧 → ノート一覧（新しい順、200件ずつ）→ ノート表示 |
| 画像 | 本文中の画像を、Drive の添付フォルダから自動で読み込んで本文内に表示（タップで拡大） |
| 添付 | PDF・音声などは本文中のボタンから Drive のプレビューで開く |
| 検索 | 上部の検索欄で全ノートを全文検索、ノートブック内の絞り込み検索 |
| 登録 | タイトル・本文・タグ・写真（カメラ撮影可）・添付ファイルをまとめて保存 |
| PC 操作 | 登録画面へのドラッグ＆ドロップ、画像の貼り付け（Ctrl+V） |
| 下書き | 入力途中の内容は自動保存（通信エラーでも消えません） |

## 保存形式（バックアップと同じ構成）

```
WebClips/Evernoteバックアップ_EvernoteBackup/
├─ 02_Markdown変換_Markdown/<ノートブック>/YYYYMMDD_タイトル.md
└─ 03_添付ファイル_Attachments/<ノートブック>/YYYYMMDDhhmmss_01_ファイル名
```

新しいノートも過去のノートと同じ場所・同じ形式で保存されるため、一緒に閲覧・検索できます。

## 公開手順（初回のみ）

1. GitHub で新しいリポジトリ `drive-notes` を作成（Public）
2. このフォルダの中身（`index.html` などのファイルと `lib` フォルダ）をそのままアップロード
3. リポジトリの Settings → Pages → Branch を `main` / `(root)` にして Save
4. 数分後、 `https://sakaguchinao10-cyber.github.io/drive-notes/` で開けます

OAuth クライアントは DriveClipper PWA と同じもの（同じ github.io ドメイン）を使うため、
Google Cloud 側の設定変更は不要の見込みです。ログインで `redirect_uri_mismatch` や
`origin` のエラーが出た場合は、PWA 用 OAuth クライアントの「承認済みの JavaScript 生成元」に
`https://sakaguchinao10-cyber.github.io` があるか確認してください。

## インストール

- **iPhone / iPad**：Safari で開く → 共有 → 「ホーム画面に追加」
- **Android**：Chrome で開く → メニュー → 「アプリをインストール」
- **PC（Chrome）**：アドレスバー右端のインストールアイコン → 「インストール」

## 使い方の注意

- ログインは約1時間で切れます（Google の仕様）。切れたら画面上部の「再ログイン」を押してください。
  登録画面の入力内容は残ります。
- アクセスできるのは DriveClippers プロジェクトのアプリで作成したファイルだけです（drive.file）。
  Drive 上で手動で作ったファイルは表示されません。
- 写真は原寸で保存します。容量を抑えたいときは「写真を縮小して保存する」にチェックを入れてください。
- ノートの編集・削除は現バージョンにはありません（Drive で直接行えます）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| index.html | 画面の骨組み |
| app.js | アプリ本体（閲覧・登録・Drive 連携） |
| style.css | デザイン（ライト／ダーク対応） |
| config.js | 設定（OAuth クライアントID・フォルダ名） |
| sw.js / manifest.webmanifest | PWA（インストール・オフライン起動） |
| lib/ | Markdown 表示ライブラリ（marked、DOMPurify。各ライセンス同梱） |

Web アプリの決まりで、`index.html` などのファイル名は英語のみにしています。
文字コードはすべて UTF-8 です（ブラウザ・GitHub Pages の標準）。
