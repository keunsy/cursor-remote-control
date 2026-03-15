-- 模拟 Command+O 快捷键切换飞连 VPN
-- 必须先激活应用到前台，快捷键才会发送到正确的应用
tell application "CorpLink" to activate
delay 0.5
tell application "System Events"
    tell process "CorpLink"
        keystroke "o" using {command down}
    end tell
end tell
