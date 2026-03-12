@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REMOTE=%~1"
if "%REMOTE%"=="" set "REMOTE=origin"

set "BRANCH=%~2"
if "%BRANCH%"=="" set "BRANCH=main"

set "MESSAGE=%~3"
if "%MESSAGE%"=="" set "MESSAGE=sync: update from MAC"

set "JSON_DIR=Json"
set "JSON_BACKUP="
set "HAS_CHANGES=0"
set "NEEDS_STASH=0"
set "STASH_NAME="

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Errore: esegui questo script dentro una repository Git.
  exit /b 1
)

echo [MAC_to_Remote.bat] Pubblicazione verso %REMOTE%/%BRANCH%

if exist "%JSON_DIR%" (
  set "JSON_BACKUP=%TEMP%\json_backup_%RANDOM%_%RANDOM%"
  xcopy "%JSON_DIR%" "%JSON_BACKUP%\%JSON_DIR%\" /E /I /Y >nul
  echo [MAC_to_Remote.bat] Cartella %JSON_DIR%\ preservata in backup temporaneo.
)

set "STATUS_FILE=%TEMP%\git_status_%RANDOM%_%RANDOM%.tmp"
git status --porcelain > "%STATUS_FILE%"
for %%A in ("%STATUS_FILE%") do (
  if %%~zA GTR 0 set "HAS_CHANGES=1"
)
del "%STATUS_FILE%" >nul 2>&1

if "!HAS_CHANGES!"=="1" (
  git add -A
  git restore --staged "%JSON_DIR%" >nul 2>&1
  git diff --cached --quiet
  if errorlevel 1 (
    git commit -m "%MESSAGE%"
    if errorlevel 1 exit /b 1
  ) else (
    echo [MAC_to_Remote.bat] Solo modifiche in %JSON_DIR%\: nessun commit da creare.
  )
) else (
  echo [MAC_to_Remote.bat] Nessuna modifica locale da committare.
)

set "STATUS_FILE=%TEMP%\git_status_%RANDOM%_%RANDOM%.tmp"
git status --porcelain > "%STATUS_FILE%"
for %%A in ("%STATUS_FILE%") do (
  if %%~zA GTR 0 set "NEEDS_STASH=1"
)
del "%STATUS_FILE%" >nul 2>&1

if "!NEEDS_STASH!"=="1" (
  set "STASH_NAME=auto-stash-mac-to-remote-%DATE%-%TIME%"
  set "STASH_NAME=!STASH_NAME:/=-!"
  set "STASH_NAME=!STASH_NAME::=-!"
  set "STASH_NAME=!STASH_NAME: =!"
  echo [MAC_to_Remote.bat] Creo stash temporaneo per consentire rebase pulito...
  git stash push -u -m "!STASH_NAME!" >nul
  if errorlevel 1 (
    echo [MAC_to_Remote.bat] Errore durante lo stash.
    exit /b 1
  )
)

git ls-remote --exit-code --heads "%REMOTE%" "%BRANCH%" >nul 2>&1
if errorlevel 1 (
  echo [MAC_to_Remote.bat] Branch remoto %REMOTE%/%BRANCH% non trovato: eseguo primo push.
) else (
  git fetch "%REMOTE%"
  if errorlevel 1 exit /b 1

  git pull --rebase "%REMOTE%" "%BRANCH%"
  if errorlevel 1 exit /b 1
)

git push -u "%REMOTE%" "%BRANCH%"
if errorlevel 1 exit /b 1

if not "!STASH_NAME!"=="" (
  git stash list | findstr /C:"!STASH_NAME!" >nul
  if not errorlevel 1 (
    echo [MAC_to_Remote.bat] Ripristino modifiche locali non pubblicate...
    git stash pop
    if errorlevel 1 (
      echo [MAC_to_Remote.bat] Conflitti durante stash pop. Risolvili e poi continua.
      exit /b 1
    )
  )
)

if not "%JSON_BACKUP%"=="" (
  if exist "%JSON_BACKUP%\%JSON_DIR%\" (
    if exist "%JSON_DIR%" rmdir /S /Q "%JSON_DIR%"
    xcopy "%JSON_BACKUP%\%JSON_DIR%" "%JSON_DIR%\" /E /I /Y >nul
    rmdir /S /Q "%JSON_BACKUP%"
    echo [MAC_to_Remote.bat] Ripristinata %JSON_DIR%\ locale (remota ignorata).
  )
)

echo [MAC_to_Remote.bat] Completato.
exit /b 0
