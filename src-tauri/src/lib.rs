// ──────────────────────────────────────────────────────────────
// lib.rs - Tauri アプリのライブラリエントリポイント
//   現状フロントエンド(JS)側で全ロジックを完結させているため、
//   Rust 側は最小構成。将来ネイティブ機能（ファイルダイアログの
//   拡張、ウィンドウ制御コマンド等）を追加する場合はここに
//   #[tauri::command] 関数を追加し、tauri::generate_handler! に登録する。
// ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running narikiri-vtuber");
}
