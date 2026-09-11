// ──────────────────────────────────────────────────────────────
// photo-layouts.js - フォトレイアウト定義
//
//   レイアウトの種類:
//     1. camera_avatar            : [カメラ] [アバター] を横並び
//     2. avatar                   : [アバター] のみ
//     3. avatar_skeleton          : [アバター] [骨組み] を横並び
//     4. camera_skeleton_avatar   : [カメラ+骨組み] [アバター] を横並び
//
//   カメラ表示OFF時は 1 と 4 は無効（2 と 3 のみ選択可）。
// ──────────────────────────────────────────────────────────────

export const LAYOUTS = [
  {
    id: 'camera_avatar',
    label: 'カメラ + アバター',
    requiresCamera: true,
    panes: ['camera', 'avatar'],
  },
  {
    id: 'avatar',
    label: 'アバターのみ',
    requiresCamera: false,
    panes: ['avatar'],
  },
  {
    id: 'avatar_skeleton',
    label: 'アバター + 骨組み',
    requiresCamera: false,
    panes: ['avatar', 'skeleton'],
  },
  {
    id: 'camera_skeleton_avatar',
    label: 'カメラ + 骨組み + アバター',
    requiresCamera: true,
    panes: ['cameraWithSkeleton', 'avatar'],
  },
];

// 現在の状態で選択可能なレイアウト一覧を返す
export function getAvailableLayouts(cameraActive) {
  if (cameraActive) return LAYOUTS;
  return LAYOUTS.filter((l) => !l.requiresCamera);
}

// ID からレイアウトを取得
export function getLayoutById(id) {
  return LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
}

// デフォルトレイアウト（カメラ有効時は 1、無効時は 2）
export function getDefaultLayoutId(cameraActive) {
  return cameraActive ? 'camera_avatar' : 'avatar';
}
