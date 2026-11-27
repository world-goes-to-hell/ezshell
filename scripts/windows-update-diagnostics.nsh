; electron-builder's two result hooks replace its final result handler. Keep its install error,
; retries and exit behavior, with a log only for the old uninstaller's exit code 2.
!macro ezShellUninstallResult scope scopeName
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
  ${ElseIf} $R0 != 0
    ${If} $R0 == 2
      ReadRegStr $0 ${scope} "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 == ""
        ReadRegStr $0 ${scope} "${UNINSTALL_REGISTRY_KEY}" UninstallString
        !ifdef UNINSTALL_REGISTRY_KEY_2
          ${If} $0 == ""
            ReadRegStr $0 ${scope} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
          ${EndIf}
        !endif
        !insertmacro GetInQuotes $0 "$0"
        Push $0
        Call GetFileParent
        Pop $0
      ${EndIf}
      Push "${scopeName}"
      Push $0
      Call ezShellWriteUninstallFailure
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro ezShellUninstallResult SHELL_CONTEXT "selected install scope ($installMode)"
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro ezShellUninstallResult HKEY_CURRENT_USER "current user"
!macroend

!macro ezShellWriteUninstallLine line
  Push "${line}$\r$\n"
  Call ezShellWriteUninstallLine
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
!define EZSHELL_UNINSTALL_MAX_DEPTH 32
Var ezShellUninstallLog
Var ezShellUninstallProbeBudget
Var ezShellUninstallProbeFailures
Var ezShellUninstallProbeDepth
Var ezShellUninstallDepthLimited

Function ezShellWriteUninstallLine
  Exch $0
  Push $1
  StrLen $1 $0
  IntOp $1 $1 * 2
  System::Call 'kernel32::WriteFile(p $ezShellUninstallLog, w r0, i r1, *i .r1, p 0) i'
  Pop $1
  Pop $0
FunctionEnd

; Request DELETE access to check sharing for a rename, then close the handle. Use OPEN_EXISTING
; and FILE_FLAG_OPEN_REPARSE_POINT so the probe never changes file data or follows a file symlink.
Function ezShellProbeUninstallFile
  Exch $0
  Push $1
  Push $2
  System::Call 'kernel32::CreateFileW(w r0, i 0x00010000, i 7, p 0, i 3, i 0x00200000, p 0) p .r1 ?e'
  Pop $2
  ${If} $1 != -1
    System::Call 'kernel32::CloseHandle(p r1) i'
  ${ElseIf} $2 != 2
  ${AndIf} $2 != 3
    ; 32 is a sharing violation. Other errors, such as 5 (access denied), need separate diagnosis.
    ${If} $ezShellUninstallProbeFailures < 20
      !insertmacro ezShellWriteUninstallLine "Win32 $2: $0"
    ${EndIf}
    IntOp $ezShellUninstallProbeFailures $ezShellUninstallProbeFailures + 1
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Bound both entries visited and recursive calls, skipping directory junctions and symlinks.
Function ezShellProbeUninstallDir
  Exch $0
  Push $1
  Push $2
  Push $3
  StrCpy $1 ""
  StrCpy $2 ""
  FindFirst $1 $2 "$0\*"
  ${While} $2 != ""
    ${IfThen} $ezShellUninstallProbeBudget = 0 ${|} ${Break} ${|}
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      IntOp $ezShellUninstallProbeBudget $ezShellUninstallProbeBudget - 1
      System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i .r3'
      ${If} $3 != -1
        IntOp $3 $3 & 0x410 ; reparse point (0x400) or directory (0x10)
        ${If} $3 = 0x10
          ${If} $ezShellUninstallProbeDepth < ${EZSHELL_UNINSTALL_MAX_DEPTH}
            IntOp $ezShellUninstallProbeDepth $ezShellUninstallProbeDepth + 1
            Push "$0\$2"
            Call ezShellProbeUninstallDir
            IntOp $ezShellUninstallProbeDepth $ezShellUninstallProbeDepth - 1
          ${Else}
            StrCpy $ezShellUninstallDepthLimited 1
          ${EndIf}
        ${ElseIf} $3 == 0
          Push "$0\$2"
          Call ezShellProbeUninstallFile
        ${EndIf}
      ${EndIf}
    ${EndIf}
    FindNext $1 $2
  ${EndWhile}
  ${If} $1 != ""
    FindClose $1
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ezShellWriteUninstallFailure
  Pop $0 ; old installation directory from the registry
  Pop $1 ; installation scope
  System::Call 'kernel32::GetCurrentProcessId() i .r2'
  System::Call 'kernel32::GetTickCount() i .r3'
  StrCpy $2 "$TEMP\ezShell-install-error-$2-$3.log"
  ; CREATE_NEW opens only a new file, including when the installer is elevated.
  System::Call 'kernel32::CreateFileW(w r2, i 0x40000000, i 1, p 0, i 1, i 0x80, p 0) p .r4'
  StrCpy $ezShellUninstallLog $4
  ${If} $ezShellUninstallLog == -1
    Return
  ${EndIf}
  System::Call '*(&i2 0xFEFF) p .r3'
  System::Call 'kernel32::WriteFile(p $ezShellUninstallLog, p r3, i 2, *i, p 0) i'
  System::Free $3
  !insertmacro ezShellWriteUninstallLine "ezShell ${VERSION}: old uninstaller returned 2 ($1)"
  !insertmacro ezShellWriteUninstallLine "Old install directory: $0"
  !insertmacro ezShellWriteUninstallLine "Rename-access check after the failure. Win32 32 = sharing violation, 5 = access denied."
  StrCpy $ezShellUninstallProbeFailures 0
  StrCpy $ezShellUninstallProbeBudget 4096
  StrCpy $ezShellUninstallProbeDepth 0
  StrCpy $ezShellUninstallDepthLimited 0
  ; Skip network/device paths and a reparse point at the root. The install path can be unavailable.
  StrCpy $3 $0 2 1
  ${If} $3 == ":\"
    StrCpy $3 $0 3
    System::Call 'kernel32::GetDriveTypeW(w r3) i .r3'
    ${If} $3 == 3
      System::Call 'kernel32::GetFileAttributesW(w r0) i .r3'
      IntOp $3 $3 & 0x410
      ${If} $3 = 0x10
        Push $0
        Call ezShellProbeUninstallDir
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $ezShellUninstallProbeBudget == 4096
    !insertmacro ezShellWriteUninstallLine "Old install directory could not be examined or was empty."
  ${ElseIf} $ezShellUninstallProbeFailures == 0
    !insertmacro ezShellWriteUninstallLine "No existing file refused rename access during this check."
  ${EndIf}
  ${If} $ezShellUninstallProbeBudget == 0
    !insertmacro ezShellWriteUninstallLine "Scan stopped at the 4096-entry limit."
  ${EndIf}
  ${If} $ezShellUninstallDepthLimited == 1
    !insertmacro ezShellWriteUninstallLine "Folders beyond the ${EZSHELL_UNINSTALL_MAX_DEPTH}-level depth limit were skipped."
  ${EndIf}
  ${If} $ezShellUninstallProbeFailures > 20
    !insertmacro ezShellWriteUninstallLine "Total probe failures: $ezShellUninstallProbeFailures (first 20 shown)."
  ${EndIf}
  ; Which processes still use the old install folder: its exe, or a command line naming it (an Electron
  ; copy running a script from its app.asar is not ended by the installer). 2026-11-27: the 2.40.1 -> 2.41.0
  ; update failed on a locked app.asar and the log could not say who held it. The command line itself is
  ; not written (it can carry arguments), only whether it names the folder.
  !insertmacro ezShellWriteUninstallLine "Processes using the old install directory:"
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$d = '$0'; $$all = Get-CimInstance Win32_Process; $$by = @{}; foreach ($$p in $$all) { $$by[[int]$$p.ProcessId] = $$p }; $$all | Where-Object { ($$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase)) -or ($$_.CommandLine -and $$_.CommandLine.IndexOf($$d, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -First 15 | ForEach-Object { $$parent = $$by[[int]$$_.ParentProcessId]; '{0} {1} parent={2} {3} started={4:HH:mm:ss} exe={5}' -f $$_.ProcessId, $$_.Name, $$_.ParentProcessId, $$parent.Name, $$_.CreationDate, $$_.ExecutablePath }"`
  Pop $3 ; exit code, or "error" when PowerShell could not start
  Pop $4 ; output
  ${If} $3 != 0
    !insertmacro ezShellWriteUninstallLine "(the process list could not be read: $3)"
  ${ElseIf} $4 == ""
    !insertmacro ezShellWriteUninstallLine "(none)"
  ${Else}
    Push "$4$\r$\n"
    Call ezShellWriteUninstallLine
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p $ezShellUninstallLog) i'
  DetailPrint "Update diagnosis: $2"
FunctionEnd
!endif
!macroend
