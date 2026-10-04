#!/usr/bin/env bash
# 重新生成 tauri-plugin-updater 用的 latest.json。
#
# 为什么要单独做一遍：三个打包任务（x64 / x86 / macOS）是并行跑的，tauri-action 在每个任务里
# 各写一次 latest.json，互相覆盖 —— v0.1.0 的清单里就只剩 32 位和 macOS，64 位电脑永远查不到更新。
# 这里等三个任务都结束后，按 Release 里实际有的安装包重写一份完整的。
#
# 需要环境变量：TAG（如 v0.1.2）、REPO（owner/name）、GH_TOKEN
set -euo pipefail

: "${TAG:?需要 TAG}"
: "${REPO:?需要 REPO}"

VERSION="${TAG#v}"
WORK="$(mktemp -d)"
cd "$WORK"

# 只下签名文件（很小），安装包本身不用下
gh release download "$TAG" --repo "$REPO" --pattern '*.sig' --dir sigs
gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' > assets.txt
echo "本次 Release 的资产："
cat assets.txt

jq -n --arg v "$VERSION" --arg d "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{version: $v, notes: "叮一下新版本：在「设置 → 关于」里可以看版本号和更新内容。", pub_date: $d, platforms: {}}' > latest.json

pick() { grep -m1 -E "$1" assets.txt || true; }

add() { # $1 = 平台键，$2 = 安装包文件名
  local key="$1" name="${2:-}"
  if [ -z "$name" ]; then
    echo "跳过 $key：没有对应的安装包"
    return 0
  fi
  if [ ! -f "sigs/$name.sig" ]; then
    echo "跳过 $key：缺少签名 $name.sig"
    return 0
  fi
  local sig url
  sig="$(cat "sigs/$name.sig")"
  url="https://github.com/$REPO/releases/download/$TAG/$(printf '%s' "$name" | jq -sRr @uri)"
  jq --arg k "$key" --arg s "$sig" --arg u "$url" \
    '.platforms[$k] = {signature: $s, url: $u}' latest.json > latest.tmp && mv latest.tmp latest.json
  echo "  $key -> $name"
}

X64_NSIS="$(pick '_x64-setup\.exe$')"
X64_MSI="$(pick '_x64_zh-CN\.msi$')"
X86_NSIS="$(pick '_x86-setup\.exe$')"
X86_MSI="$(pick '_x86_zh-CN\.msi$')"
MAC="$(pick '\.app\.tar\.gz$')"

# Windows：默认走 -setup.exe（装在用户目录，更新不用管理员密码）；
# 用 .msi 装的电脑由 -msi 键接管，各更新各的，不会装成两份。
add windows-x86_64        "${X64_NSIS:-$X64_MSI}"
add windows-x86_64-nsis   "$X64_NSIS"
add windows-x86_64-msi    "$X64_MSI"
add windows-i686          "${X86_NSIS:-$X86_MSI}"
add windows-i686-nsis     "$X86_NSIS"
add windows-i686-msi      "$X86_MSI"
# macOS 是通用包，Intel 和 Apple 芯片同一个文件
add darwin-x86_64         "$MAC"
add darwin-aarch64        "$MAC"
add darwin-x86_64-app     "$MAC"
add darwin-aarch64-app    "$MAC"

# 三个平台缺一不可，缺了就让这次发版红掉，免得悄悄发出一个更新不了的版本
missing=""
for key in windows-x86_64 windows-i686 darwin-x86_64; do
  jq -e --arg k "$key" '.platforms | has($k)' latest.json > /dev/null || missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "::error::latest.json 缺少平台:$missing"
  cat latest.json
  exit 1
fi

echo "最终清单："
jq '{version, platforms: (.platforms | map_values(.url))}' latest.json

gh release upload "$TAG" latest.json --repo "$REPO" --clobber
echo "latest.json 已上传"
