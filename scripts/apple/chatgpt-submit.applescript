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

on run argv
  if (count of argv) is 0 then
    set appName to "ChatGPT"
  else
    set appName to item 1 of argv
  end if

  try
    set appBundleName to appName & ".app"
    set appPath to do shell script "app=" & quoted form of appBundleName & "; for d in /Applications /System/Applications \"$HOME/Applications\"; do if [ -d \"$d/$app\" ]; then printf '%s/%s' \"$d\" \"$app\"; exit 0; fi; done; exit 1"
    tell application appName to activate
    delay 0.2
    return "{\"ok\":false,\"code\":\"computer_use_required\",\"app_name\":\"" & my jsonEscape(appName) & "\",\"message\":\"" & my jsonEscape("Activated " & appPath & "; AppleScript submit is diagnostics-only.") & "\",\"action\":\"Use OpenAI bundled Computer Use plugin to paste and submit, then save screenshot/action-log evidence.\"}"
  on error errMsg
    return "{\"ok\":false,\"code\":\"app_unavailable\",\"app_name\":\"" & my jsonEscape(appName) & "\",\"message\":\"" & my jsonEscape(appName & ".app is unavailable: " & errMsg) & "\",\"action\":\"Install ChatGPT.app or set ASK_PRO_CHATGPT_APP_NAME to the installed application name.\"}"
  end try
end run
