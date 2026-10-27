; Preserve data in place. Never restore an unchecked temporary copy over it or
; replace DataDir before the application has had a chance to migrate it.
;
; Windows keeps an executing image open without write sharing. An exclusive
; write handle also fails closed for access errors: ask the user to exit via
; the tray and retry, rather than force-killing unrelated same-name processes.
!macro KalEnsureStopped
  ${Do}
    ; Tauri's following check otherwise offers to kill every same-name process
    ; (and does so automatically in silent mode), even in another directory.
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $1
    ${If} $1 != 0
      ${IfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
        ${ExitDo}
      ${EndIf}
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\${MAINBINARYNAME}.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
      ${If} $0 != -1
        System::Call 'kernel32::CloseHandle(p r0)'
        ${ExitDo}
      ${EndIf}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请先通过托盘退出 CalendarList 和其他同名程序，然后重试。若仍无法继续，请检查安装目录的访问权限。" /SD IDCANCEL IDRETRY +2
    Abort
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KalEnsureStopped
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The application owns directory creation and safe migration on first run.
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KalEnsureStopped
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Only a manual uninstall with the explicit delete-data option removes data.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$INSTDIR\data"
    RMDir /r "$APPDATA\Kal"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
