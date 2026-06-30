@echo off
echo Running LeanLife Automated Git Commit & Push...
set PATH=%PATH%;C:\Users\Administrator\Git\cmd

REM Stage all files
git add .

REM Check if there are changes to commit
git diff --cached --quiet
if %ERRORLEVEL% equ 0 (
    echo No changes staged to commit.
    goto end
)

REM Prompt for commit message
set /p commit_msg="Enter commit message: "
if "%commit_msg%"=="" (
    set commit_msg="Automated update - LeanLife Wellness Portal"
)

REM Commit (runs pre-commit hook automatically)
git commit -m "%commit_msg%"
if %ERRORLEVEL% neq 0 (
    echo Commit failed. Check if security pre-commit hooks blocked it.
    goto end
)

REM Push
echo Pushing commits to GitHub...
git push origin main
if %ERRORLEVEL% equ 0 (
    echo Push succeeded! GitHub is up-to-date.
) else (
    echo Push failed. Your local commits are safe. Check your network or GitHub login.
)

:end
pause
