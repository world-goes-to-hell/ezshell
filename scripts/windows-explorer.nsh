; Use the files-only class so logs with custom or missing extensions can be opened.
!define EZSHELL_EXPLORER_VERB "Software\Classes\*\shell\ezShell.Open"

!macro customInstall
  WriteRegStr SHCTX "${EZSHELL_EXPLORER_VERB}" "MUIVerb" "ezShell로 열기"
  WriteRegStr SHCTX "${EZSHELL_EXPLORER_VERB}" "Icon" "$appExe,0"
  WriteRegStr SHCTX "${EZSHELL_EXPLORER_VERB}\command" "" '$\"$appExe$\" --open-explorer-file=$\"%1$\"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "${EZSHELL_EXPLORER_VERB}"
!macroend
