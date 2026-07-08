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
    set latestText to the clipboard as text
    if latestText is "" then
      return "{\"ok\":false,\"code\":\"copy_empty\",\"app_name\":\"" & my jsonEscape(appName) & "\",\"message\":\"ChatGPT copy action returned an empty clipboard.\",\"action\":\"Use Computer Use to verify the latest response is visible before copying.\"}"
    end if
    return "{\"ok\":true,\"app_name\":\"" & my jsonEscape(appName) & "\",\"text\":\"" & my jsonEscape(latestText) & "\"}"
  on error errMsg
    return "{\"ok\":false,\"code\":\"clipboard_unavailable\",\"app_name\":\"" & my jsonEscape(appName) & "\",\"message\":\"" & my jsonEscape("Could not read clipboard: " & errMsg) & "\",\"action\":\"Allow clipboard access for the terminal/Codex host, then copy the latest response again.\"}"
  end try
end run
