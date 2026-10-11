// DriveNotes 設定ファイル（文字コード: UTF-8）
// OAuth クライアントは DriveClippers プロジェクトの PWA 用（ウェブアプリ型）を使います。
// 同じプロジェクトのクライアントなので、drive.file スコープのまま
// Evernote バックアップ（EvernoteDriveBackup）と DriveClipper の保存ファイルにアクセスできます。
window.DRIVENOTES_CONFIG = {
  clientId: '548818324610-44ncv651psd7j0i7epflh4avouve56dk.apps.googleusercontent.com',

  // Evernote バックアップのルートフォルダ（WebClips 配下）
  rootFolderName: 'Evernoteバックアップ_EvernoteBackup',
  markdownFolderName: '02_Markdown変換_Markdown',
  attachmentsFolderName: '03_添付ファイル_Attachments',

  // 写真を縮小して保存するときの長辺ピクセル数
  resizeMaxPx: 2560,

  // 操作がないまま この分数が過ぎると自動でログアウトする
  autoLogoutMinutes: 15,

  // Drive からの取り込み（Google Picker）用
  // pickerApiKey は Google Cloud で作成した API キー（ウェブサイト制限: sakaguchinao10-cyber.github.io）
  pickerApiKey: 'AIzaSyAvoLmWiaMHnOf6xm_N6Kxhn_7qSfaPCzA',
  appId: '548818324610', // DriveClippers のプロジェクト番号
};
