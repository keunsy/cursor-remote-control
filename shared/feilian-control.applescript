-- 模拟 Command+O 快捷键切换飞连 VPN
-- 只针对飞连（CorpLink）应用发送，避免影响其他应用（如 Cursor）
tell application "System Events"
    tell application process "CorpLink"
        keystroke "o" using {command down}
    end tell
end tell
