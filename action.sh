#!/system/bin/sh
# ============================================================
# LSPosed 管理器快速入口
# 让 KernelSU / Magisk 模块页的「执行」按钮，达到
# 与「点按 LSPosed 通知 → 打开管理器」完全相同的效果
#
# 放置：/data/adb/modules/zygisk_lsposed/action.sh   （0755）
# ============================================================
PKG=org.lsposed.manager
ACT=org.lsposed.manager.ui.activity.MainActivity
CODE=5776733

ok() { echo "✓ $*"; }

# 1) 管理器已正常安装 → 直接拉起
#    （等价于 LSPosed 内部 m548s() 里的 startActivityAsUser）
if pm path "$PKG" >/dev/null 2>&1; then
  if am start -n "$PKG/$ACT" \
        -a android.intent.action.MAIN \
        -c android.intent.category.LAUNCHER >/dev/null 2>&1; then
    ok "已打开管理器（已安装模式）"
    exit 0
  fi
  if command -v monkey >/dev/null 2>&1 && \
     monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; then
    ok "已打开管理器（monkey 兜底）"
    exit 0
  fi
  echo "… 直接启动失败，改用 secret code"
fi

# 2) 未安装 / 寄生管理器 / 上一步失败 → 走 secret code
#    与「点按通知」在 LSPosed 内部汇合于同一个函数
#    BinderC0263u8.m548s(null)，效果一致
API=$(getprop ro.build.version.sdk)
if [ "$API" -ge 29 ]; then
  am broadcast -a android.telephony.action.SECRET_CODE \
      -d "android_secret_code://$CODE" android >/dev/null 2>&1
else
  am broadcast -a android.provider.Telephony.SECRET_CODE \
      -d "android_secret_code://$CODE" android >/dev/null 2>&1
fi
sleep 2

# 3) 自检
TOP=$(dumpsys activity activities 2>/dev/null)
case "$TOP" in
  *"$PKG"*)        ok "已打开管理器（secret code 生效）"; exit 0 ;;
  *com.android.shell*) ok "已打开管理器（寄生模式）"; exit 0 ;;
esac

if ps -A 2>/dev/null | grep -q "[l]spd"; then
  echo "✗ lspd 在运行，但管理器没有起来"
  echo "  → system_server 未被注入：确认 Zygisk 已启用、模块已开、已重启"
  echo "  → 诊断：logcat -d -s LSPosedService | tail -30"
  echo "    正常应含 registered open manager receiver / starting manager"
else
  echo "✗ lspd 未运行"
  echo "  → Zygisk 未生效 / LSPosed 模块被禁用 / 还没重启设备"
fi
exit 1
