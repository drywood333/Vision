@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REMOTE=%~1"
if "%REMOTE%"=="" set "REMOTE=origin"

set "BRANCH=%~2"
if "%BRANCH%"=="" set "BRANCH=main"

set "JSON_DIR=Json"
set "JSON_BACKUP="
set "STASH_NAME="
set "HAS_CHANGES=0"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Errore: esegui questo script dentro una repository Git.
  exit /b 1
)

echo [Remote_to_MAC.bat] Sincronizzazione da %REMOTE%/%BRANCH%

if exist "%JSON_DIR%" (
  set "JSON_BACKUP=%TEMP%\json_backup_%RANDOM%_%RANDOM%"
  xcopy "%JSON_DIR%" "%JSON_BACKUP%\%JSON_DIR%\" /E /I /Y >nul
  echo [Remote_to_MAC.bat] Cartella %JSON_DIR%\ preservata in backup temporaneo.
)

set "STATUS_FILE=%TEMP%\git_status_%RANDOM%_%RANDOM%.tmp"
git status --porcelain > "%STATUS_FILE%"
for %%A in ("%STATUS_FILE%") do (
  if %%~zA GTR 0 set "HAS_CHANGES=1"
)
del "%STATUS_FILE%" >nul 2>&1

if "!HAS_CHANGES!"=="1" (
  set "STASH_NAME=auto-stash-remote-to-mac-%DATE%-%TIME%"
  set "STASH_NAME=!STASH_NAME:/=-!"
  set "STASH_NAME=!STASH_NAME::=-!"
  set "STASH_NAME=!STASH_NAME: =!"
  echo [Remote_to_MAC.bat] Modifiche locali rilevate: creo stash temporaneo (!STASH_NAME!)...
  git stash push -u -m "!STASH_NAME!" >nul
  if errorlevel 1 (
    echo [Remote_to_MAC.bat] Errore durante lo stash.
    exit /b 1
  )
)

git fetch "%REMOTE%"
if errorlevel 1 exit /b 1

git pull --rebase "%REMOTE%" "%BRANCH%"
if errorlevel 1 exit /b 1

if not "!STASH_NAME!"=="" (
  git stash list | findstr /C:"!STASH_NAME!" >nul
  if not errorlevel 1 (
    echo [Remote_to_MAC.bat] Ripristino modifiche locali...
    git stash pop
    if errorlevel 1 (
      echo [Remote_to_MAC.bat] Conflitti durante stash pop. Risolvili e poi continua.
      exit /b 1
    )
  )
)

if not "%JSON_BACKUP%"=="" (
  if exist "%JSON_BACKUP%\%JSON_DIR%\" (
    if exist "%JSON_DIR%" rmdir /S /Q "%JSON_DIR%"
    xcopy "%JSON_BACKUP%\%JSON_DIR%" "%JSON_DIR%\" /E /I /Y >nul
    rmdir /S /Q "%JSON_BACKUP%"
    echo [Remote_to_MAC.bat] Ripristinata %JSON_DIR%\ locale (remota ignorata).
  )
)

echo [Remote_to_MAC.bat] Completato.
exit /b 0
