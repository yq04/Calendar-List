; CalendarList NSIS Upgrade & Data Preservation Hooks (v0.1.1+)
; 1. Automatically closes running kal.exe before overwrite install / uninstall so the user only needs to click Next.
; 2. Preserves $INSTDIR\data (user database, settings, themes, fonts, backups, logs) across upgrades and default uninstalls.

!macro NSIS_HOOK_PREINSTALL
  ; Gracefully stop any running CalendarList (kal.exe) instance before replacing binary
  nsExec::ExecToStack 'taskkill /F /IM "${MAINBINARYNAME}.exe" /T'
  Pop $0
  Pop $1
  Sleep 250

  ; If existing installation has a local data folder, back it up in $TEMP as double insurance
  ${If} ${FileExists} "$INSTDIR\data\*.*"
    CreateDirectory "$TEMP\CalendarList_Upgrade_Backup\data"
    CopyFiles /SILENT "$INSTDIR\data\*.*" "$TEMP\CalendarList_Upgrade_Backup\data"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Ensure local data directory exists inside the user's chosen installation path
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\data\sandbox"
  CreateDirectory "$INSTDIR\data\backups"
  CreateDirectory "$INSTDIR\data\themes"
  CreateDirectory "$INSTDIR\data\fonts"
  CreateDirectory "$INSTDIR\data\logs"

  ; Restore from temporary upgrade backup if needed
  ${If} ${FileExists} "$TEMP\CalendarList_Upgrade_Backup\data\*.*"
    CopyFiles /SILENT "$TEMP\CalendarList_Upgrade_Backup\data\*.*" "$INSTDIR\data"
    RMDir /r "$TEMP\CalendarList_Upgrade_Backup"
  ${EndIf}

  ; If user has legacy v0.1.0 data in %APPDATA%\Kal and $INSTDIR\data is fresh, pre-seed it during install
  ${IfNot} ${FileExists} "$INSTDIR\data\sandbox\kal_sandbox.db"
    ${If} ${FileExists} "$APPDATA\Kal\sandbox\kal_sandbox.db"
      CopyFiles /SILENT "$APPDATA\Kal\*.*" "$INSTDIR\data"
    ${EndIf}
  ${EndIf}

  ; Record DataDir in HKCU so future upgrades or directory changes can always locate user data
  WriteRegStr HKCU "Software\kal\CalendarList" "DataDir" "$INSTDIR\data"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Automatically close running instance before uninstall / upgrade
  nsExec::ExecToStack 'taskkill /F /IM "${MAINBINARYNAME}.exe" /T'
  Pop $0
  Pop $1
  Sleep 250
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; By default ($DeleteAppDataCheckboxState != 1 or during $UpdateMode = 1), KEEP $INSTDIR\data and %APPDATA%\Kal!
  ; Only delete user data if user explicitly checked "Delete application data" during a manual uninstall.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$INSTDIR\data"
    RMDir /r "$APPDATA\Kal"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
