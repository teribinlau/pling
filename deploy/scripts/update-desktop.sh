#!/usr/bin/env bash
# 叮一下 · 把电脑客户端的安装包和自动更新清单放到本机（https://你的域名/downloads/）
# 已经装了客户端的电脑会从这里自动更新（客户端读 /config.json 里的 updatesUrl）。
#
#   scripts/update-desktop.sh 0.2.0              从发布地址下载 0.2.0 的安装包和 latest.json
#   scripts/update-desktop.sh --dir /root/pling-0.2.0   用已经下载好的文件（目录里要有 latest.json 和它列出的安装包）
#
# 发布地址：.env 的 PLING_RELEASE_BASE（默认 GitHub Releases）。latest.json 里的下载地址会改成本机地址。
source "$(dirname "$0")/lib.sh"

SRC_DIR= VER=
case "${1:-}" in
  --dir) SRC_DIR=${2:?--dir 后面要跟目录} ;;
  "") die "用法：scripts/update-desktop.sh 版本号 | --dir 目录" ;;
  *) VER=${1#v} ;;
esac

pub=$(public_url)
[[ -n "$pub" ]] || die ".env 里没有 PLING_PUBLIC_URL"
DEST="$(data_dir)/downloads"
mkdir -p "$DEST"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

base=$(env_get PLING_RELEASE_BASE)
base=${base:-https://github.com/teribinlau/pling/releases/download}

fetch() { # fetch 文件名 → $tmp/文件名
  local name=$1
  if [[ -n "$SRC_DIR" ]]; then
    [[ -f "$SRC_DIR/$name" ]] || die "目录里没有 $name"
    cp "$SRC_DIR/$name" "$tmp/$name"
  else
    info "下载 $name"
    curl -fL --retry 3 -o "$tmp/$name" "${base%/}/v$VER/$name" || die "下载 $name 失败"
  fi
}

fetch latest.json
grep -q '"platforms"' "$tmp/latest.json" || die "latest.json 格式不对"
version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$tmp/latest.json" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')

# latest.json 里每个平台的下载地址：取文件名，下载，再把地址换成本机的
mapfile -t urls < <(grep -oE '"url"[[:space:]]*:[[:space:]]*"[^"]+"' "$tmp/latest.json" | sed -E 's/.*"(https?:[^"]+)"$/\1/' | sort -u)
(( ${#urls[@]} )) || die "latest.json 里没有下载地址"
cp "$tmp/latest.json" "$tmp/latest.local.json"
for u in "${urls[@]}"; do
  name=$(basename "${u%%\?*}")
  name=$(printf '%b' "${name//%/\\x}")   # URL 解码（文件名里的空格等）
  [[ -f "$tmp/$name" ]] || fetch "$name"
  local_url="$pub/downloads/$(printf '%s' "$name" | sed 's/ /%20/g')"
  esc_u=$(printf '%s' "$u" | sed 's/[][\.*^$/&]/\\&/g')
  esc_l=$(printf '%s' "$local_url" | sed 's/[&/\]/\\&/g')
  sed -i "s/$esc_u/$esc_l/g" "$tmp/latest.local.json"
done

# 也放一份方便手动下载的安装包（Windows 64 / 32 位、Mac）
for f in "$tmp"/*; do
  case "$(basename "$f")" in
    latest.json|latest.local.json) ;;
    *) cp "$f" "$DEST/" ;;
  esac
done
mv "$tmp/latest.local.json" "$DEST/latest.json"
chmod 644 "$DEST"/*
ok "电脑客户端 $version 已放到 $pub/downloads/（自动更新清单：$pub/downloads/latest.json）"
ls -1 "$DEST"
