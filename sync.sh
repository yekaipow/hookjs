#!/bin/bash
# 把 workspace 里的脚本同步进仓库并推送
# 用法: ./sync.sh [commit message]
set -e
cd "$(dirname "$0")"

MSG="${1:-chore: 同步脚本更新 $(date '+%Y-%m-%d %H:%M')}"

# 同步源文件
[ -f /workspace/outputs/douyin_ktv_top3_download.js ] && \
  cp /workspace/outputs/douyin_ktv_top3_download.js douyin-ktv/

git add -A
if git diff --cached --quiet; then
  echo "无变更，跳过提交"
  exit 0
fi
git commit -q -m "$MSG"
GIT_SSH_COMMAND="ssh -i $HOME/.ssh/github_key -o IdentitiesOnly=yes" git push origin main
echo "✓ 已推送: $MSG"
