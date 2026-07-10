' Silently start the YouTube subtitle reader server (no window)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\admin\youtube-subtitle-reader"
shell.Run """C:\Program Files\nodejs\node.exe"" server.js", 0, False
