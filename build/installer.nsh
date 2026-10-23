# An update removes the old app before copying the new one, so finish an interrupted one at next sign-in.
!define UPDATE_RUN_ONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define UPDATE_RUN_ONCE_NAME "${PRODUCT_NAME} update"

!macro customInit
  ${if} ${isUpdated}
    WriteRegStr HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}" '"$EXEPATH" --updated /S --force-run /D=$INSTDIR'
  ${endIf}
!macroend

!macro customInstall
  DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}"
  ${endIf}
!macroend
