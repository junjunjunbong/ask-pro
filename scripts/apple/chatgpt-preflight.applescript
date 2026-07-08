on replaceText(findText, replaceTextValue, sourceText)
  set AppleScript's text item delimiters to findText
  set textItems to text items of sourceText
  set AppleScript's text item delimiters to replaceTextValue
  set joinedText to textItems as text
  set AppleScript's text item delimiters to ""
  return joinedText
end replaceText

on jsonEscape(sourceText)
  set escapedText to sourceText as text
  set escapedText to my replaceText("\\", "\\\\", escapedText)
  set escapedText to my replaceText("\"", "\\\"", escapedText)
  set escapedText to my replaceText(linefeed, "\\n", escapedText)
  set escapedText to my replaceText(return, "\\n", escapedText)
  return escapedText
end jsonEscape

on boolJson(flag)
  if flag then
    return "true"
  end if
  return "false"
end boolJson

on checkJson(checkName, okFlag, messageText, actionText)
  set itemJson to "{\"name\":\"" & my jsonEscape(checkName) & "\",\"ok\":" & my boolJson(okFlag) & ",\"message\":\"" & my jsonEscape(messageText) & "\""
  if actionText is not "" then
    set itemJson to itemJson & ",\"action\":\"" & my jsonEscape(actionText) & "\""
  end if
  return itemJson & "}"
end checkJson

on run argv
  if (count of argv) is 0 then
    set appName to "ChatGPT"
  else
    set appName to item 1 of argv
  end if

  set checks to {}
  set appAvailable to false

  try
    set appBundleName to appName & ".app"
    set appPath to do shell script "app=" & quoted form of appBundleName & "; for d in /Applications /System/Applications \"$HOME/Applications\"; do if [ -d \"$d/$app\" ]; then printf '%s/%s' \"$d\" \"$app\"; exit 0; fi; done; exit 1"
    set end of checks to my checkJson("app_installed", true, "found " & appPath, "")
    set appAvailable to true
  on error errMsg
    set end of checks to my checkJson("app_installed", false, appName & ".app was not found in /Applications, /System/Applications, or ~/Applications.", "Install ChatGPT.app, or set ASK_PRO_CHATGPT_APP_NAME to the installed application name.")
  end try

  if appAvailable then
    try
      tell application appName to activate
      delay 0.2
      set end of checks to my checkJson("activate_app", true, "activated " & appName, "")
    on error errMsg
      set end of checks to my checkJson("activate_app", false, "could not activate " & appName & ": " & errMsg, "Open ChatGPT.app once manually, then rerun chatgpt-preflight.")
    end try
  else
    set end of checks to my checkJson("activate_app", false, "skipped because " & appName & ".app is unavailable", "Install ChatGPT.app before attempting a session.")
  end if

  try
    tell application "System Events" to set uiEnabled to UI elements enabled
    if uiEnabled then
      set end of checks to my checkJson("accessibility", true, "System Events UI scripting is enabled", "")
    else
      set end of checks to my checkJson("accessibility", false, "System Events UI scripting is disabled", "Enable Accessibility for the terminal/Codex host and osascript in macOS Privacy & Security settings.")
    end if
  on error errMsg
    set end of checks to my checkJson("accessibility", false, "could not query System Events UI scripting: " & errMsg, "Grant Automation and Accessibility permissions, then rerun chatgpt-preflight.")
  end try

  try
    set oldClipboard to the clipboard
    set marker to "__ask_pro_chatgpt_clipboard_preflight__"
    set the clipboard to marker
    delay 0.1
    if (the clipboard as text) is marker then
      set end of checks to my checkJson("clipboard", true, "clipboard is writable and readable", "")
    else
      set end of checks to my checkJson("clipboard", false, "clipboard round trip did not preserve the marker", "Check clipboard privacy prompts and rerun chatgpt-preflight.")
    end if
    set the clipboard to oldClipboard
  on error errMsg
    set end of checks to my checkJson("clipboard", false, "clipboard check failed: " & errMsg, "Allow clipboard access for the terminal/Codex host, then rerun chatgpt-preflight.")
  end try

  try
    do shell script "tmp=\"${TMPDIR:-/tmp}/ask-pro-chatgpt-preflight-$$.png\"; screencapture -x -t png \"$tmp\" >/dev/null 2>&1; rc=$?; rm -f \"$tmp\"; exit $rc"
    set end of checks to my checkJson("screenshot", true, "screencapture can capture a diagnostic screenshot", "")
  on error errMsg
    set end of checks to my checkJson("screenshot", false, "screenshot check failed: " & errMsg, "Grant Screen Recording permission for the terminal/Codex host, then rerun chatgpt-preflight.")
  end try

  set okFlag to true
  repeat with checkItem in checks
    if checkItem contains "\"ok\":false" then
      set okFlag to false
    end if
  end repeat

  set AppleScript's text item delimiters to ","
  set checksJson to checks as text
  set AppleScript's text item delimiters to ""

  return "{\"ok\":" & my boolJson(okFlag) & ",\"app_name\":\"" & my jsonEscape(appName) & "\",\"checks\":[" & checksJson & "]}"
end run
