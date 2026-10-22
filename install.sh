#!/usr/bin/env bash
#
# 安装喜马拉雅干净客户端到当前用户（不需要 root）。
#
#   ./install.sh             安装 / 更新
#   ./install.sh --uninstall 卸载
#
# 会做三件事：
#   1. 把 xmly 命令链接到 ~/.local/bin
#   2. 在桌面放一个快捷方式
#   3. 尽量往应用菜单里加一项（目录不可写时自动跳过）
#
set -uo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BIN_DIR="$HOME/.local/bin"
ICON_SRC="$APP_DIR/assets/icon.svg"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
FILE_NAME="ximalaya-clean.desktop"

warn() { printf '  ! %s\n' "$*" >&2; }
ok()   { printf '  ✓ %s\n' "$*"; }

can_write_dir() {
  local d="$1"
  mkdir -p "$d" 2>/dev/null || return 1
  local probe="$d/.xmly-write-test-$$"
  if ( : >"$probe" ) 2>/dev/null; then rm -f "$probe"; return 0; fi
  return 1
}

desktop_entry() {
  cat <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=喜马拉雅 · 干净版
Name[zh_CN]=喜马拉雅 · 干净版
Name[en]=Ximalaya Clean
GenericName=有声书播放器
Comment=无广告的喜马拉雅听书客户端
Comment[zh_CN]=无广告的喜马拉雅听书客户端
Comment[en]=Ad-free Ximalaya desktop client
Exec=$1
Icon=$2
Terminal=false
Categories=AudioVideo;Audio;Player;Network;
Keywords=ximalaya;喜马拉雅;听书;有声书;podcast;评书;相声;
StartupNotify=true
StartupWMClass=xmly-clean
EOF
}

# ---------------------------------------------------------------- 卸载
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/xmly"
  rm -f "$DESKTOP_DIR/$FILE_NAME"
  rm -f "$APPS_DIR/$FILE_NAME"
  rm -f "$ICON_DIR/ximalaya-clean.svg"
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$APPS_DIR" 2>/dev/null || true
  echo "已卸载。配置与登录信息保留在 ~/.config/ximalaya-clean"
  echo "想彻底清干净： rm -rf ~/.config/ximalaya-clean"
  exit 0
fi

# ---------------------------------------------------------------- 检查 node
NODE=""
for c in "$HOME/.local/node/bin/node" /usr/bin/node /usr/local/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  echo "✗ 找不到 Node.js（需要 20 或更高版本）" >&2
  echo "  SteamOS / Arch:  sudo pacman -S nodejs npm" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "✗ Node.js 版本过低（当前 $("$NODE" -v)，需要 >= 20）" >&2
  exit 1
fi

echo "安装喜马拉雅干净版"
echo "  项目目录： $APP_DIR"
echo "  Node：     $NODE ($("$NODE" -v 2>/dev/null))"
echo

chmod +x "$APP_DIR/bin/xmly" 2>/dev/null

# ---------------------------------------------------------------- 1. 命令
if can_write_dir "$BIN_DIR"; then
  ln -sf "$APP_DIR/bin/xmly" "$BIN_DIR/xmly"
  ok "命令已安装： $BIN_DIR/xmly"
else
  warn "无法写入 $BIN_DIR，跳过命令安装"
fi

# ---------------------------------------------------------------- 2. 图标
ICON_LINE="$ICON_SRC"
if can_write_dir "$ICON_DIR"; then
  if cp "$ICON_SRC" "$ICON_DIR/ximalaya-clean.svg" 2>/dev/null; then
    chmod 644 "$ICON_DIR/ximalaya-clean.svg" 2>/dev/null
    ICON_LINE="ximalaya-clean"
  fi
fi

# ---------------------------------------------------------------- 3. 桌面快捷方式
EXEC_LINE="$APP_DIR/bin/xmly start"
installed_desktop=0
if can_write_dir "$DESKTOP_DIR"; then
  if desktop_entry "$EXEC_LINE" "$ICON_LINE" >"$DESKTOP_DIR/$FILE_NAME" 2>/dev/null; then
    chmod +x "$DESKTOP_DIR/$FILE_NAME" 2>/dev/null
    # GNOME / KDE 需要标记为可信才能双击运行
    gio set "$DESKTOP_DIR/$FILE_NAME" metadata::trusted true 2>/dev/null || true
    ok "桌面快捷方式： $DESKTOP_DIR/$FILE_NAME"
    installed_desktop=1
  else
    warn "无法创建桌面快捷方式"
  fi
else
  warn "桌面目录不可写，跳过桌面快捷方式"
fi

# ---------------------------------------------------------------- 4. 应用菜单
if can_write_dir "$APPS_DIR"; then
  if desktop_entry "$EXEC_LINE" "$ICON_LINE" >"$APPS_DIR/$FILE_NAME" 2>/dev/null; then
    chmod +x "$APPS_DIR/$FILE_NAME" 2>/dev/null
    command -v update-desktop-database >/dev/null 2>&1 &&
      update-desktop-database "$APPS_DIR" 2>/dev/null || true
    ok "应用菜单： 搜「喜马拉雅」或「Ximalaya」"
  else
    warn "无法写入应用菜单"
  fi
else
  warn "应用菜单目录不可写（属主不是当前用户），已跳过"
  echo "     不影响使用：桌面快捷方式和 xmly 命令都能用"
fi

echo
echo "完成。"
[ "$installed_desktop" = 1 ] && echo "  双击桌面的「喜马拉雅 · 干净版」即可启动"
echo "  或终端运行： xmly"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  提示： $BIN_DIR 不在 PATH 里，先执行 export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
