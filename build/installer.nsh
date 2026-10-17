; Native dark installer theme and Chinese product copy.
!define MUI_BGCOLOR "1C2129"
!define MUI_TEXTCOLOR "EDF1F7"
!define MUI_INSTFILESPAGE_COLORS "EDF1F7 15191F"
!define MUI_CUSTOMFUNCTION_GUIINIT XhsInstallerGuiInit
!define MUI_WELCOMEPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TITLE "小红书更新监控已准备就绪"
!define MUI_FINISHPAGE_TEXT "安装完成。现在可以添加博主主页，设置检测间隔，并接收新笔记提醒。$\r$\n$\r$\n监控配置和加密登录信息保存在程序旁的 data 文件夹。"
!define MUI_FINISHPAGE_RUN_TEXT "打开小红书更新监控"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "关注的更新，$\r$\n都在这里。"
  !define MUI_WELCOMEPAGE_TEXT "欢迎安装小红书更新监控 ${VERSION}。$\r$\n$\r$\n多个博主，统一关注$\r$\n独立间隔，随机检测$\r$\n新文提醒，持续守候$\r$\n$\r$\n接下来选择安装位置，即可开始使用。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

Function XhsInstallerGuiInit
  StrCpy $LANGUAGE 2052
  SetCtlColors $HWNDPARENT EDF1F7 1C2129
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 FFFFFF F04462
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 EDF1F7 303844
  GetDlgItem $0 $HWNDPARENT 3
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SetCtlColors $0 EDF1F7 303844
FunctionEnd

; Keep the user's exe-adjacent data directory during both upgrades and uninstall.
; The default electron-builder uninstaller recursively removes the whole INSTDIR.
!macro customRemoveFiles
  FindFirst $R0 $R1 "$INSTDIR\*"
  xhs_remove_next:
    StrCmp $R1 "" xhs_remove_done
    StrCmp $R1 "." xhs_remove_skip
    StrCmp $R1 ".." xhs_remove_skip
    StrCmp $R1 "data" xhs_remove_skip
    IfFileExists "$INSTDIR\$R1\*.*" xhs_remove_directory xhs_remove_file
    xhs_remove_directory:
      RMDir /r "$INSTDIR\$R1"
      Goto xhs_remove_skip
    xhs_remove_file:
      Delete "$INSTDIR\$R1"
    xhs_remove_skip:
      FindNext $R0 $R1
      Goto xhs_remove_next
  xhs_remove_done:
    FindClose $R0
    SetOutPath $TEMP
    RMDir "$INSTDIR"
    ClearErrors
!macroend

!macro customInit
  StrCpy $LANGUAGE 2052
  InitPluginsDir
  !insertmacro XhsReportProgress "extract"
!macroend

; A private per-run bridge for the native front end, never written into user data.
!macro XhsReportProgress STAGE
  Push $0
  Push $1
  ReadEnvStr $0 "XHS_SETUP_PROGRESS_FILE"
  StrCmp $0 "" xhs_progress_done_${STAGE}
  FileOpen $1 $0 w
  IfErrors xhs_progress_done_${STAGE}
  FileWrite $1 "$PLUGINSDIR$\r$\n${STAGE}$\r$\n"
  FileClose $1
  xhs_progress_done_${STAGE}:
  Pop $1
  Pop $0
  ClearErrors
!macroend

!macro customFiles_x64
  !insertmacro XhsReportProgress "files"
!macroend

!macro customInstall
  !insertmacro XhsReportProgress "finalize"
!macroend
