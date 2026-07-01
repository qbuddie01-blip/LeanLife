# staged files query
$stagedFiles = git diff --cached --name-only

$sensitivePatterns = @(
    "\.env(\.(?!example)[a-zA-Z0-9_-]+)?$"
    "\.pem$"
    "\.key$"
    "\.pfx$"
    "\.cer$"
    "credential"
    "secret"
    "password"
    "service-account"
    "database_backup"
)

$blockedFiles = @()

foreach ($file in $stagedFiles) {
    # 1. Check file name patterns
    foreach ($pattern in $sensitivePatterns) {
        if ($file -match $pattern) {
            $blockedFiles += "[Pattern Match: $pattern] $file"
            break
        }
    }
    
    # 2. Scan contents of key text files for potential hardcoded secret templates
    if (Test-Path $file) {
        $ext = [System.IO.Path]::GetExtension($file)
        if ($ext -in @('.json', '.js', '.ts', '.html', '.css', '.txt', '.yml', '.yaml', '.xml')) {
            $content = Get-Content -Path $file -Raw
            if ($content -match '(api_key|client_secret|client_id|database_password|db_pass|aws_secret|token)\s*[:=]\s*[''"][a-zA-Z0-9_\-\+\/]{16,}[''"]') {
                $blockedFiles += "[Hardcoded Secret Match] $file"
            }
        }
    }
}

if ($blockedFiles.Count -gt 0) {
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "CRITICAL SECURITY WARNING: STAGED SECRETS DETECTED" -ForegroundColor Red
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "The commit has been aborted because the following files contain potential secrets or sensitive parameters:" -ForegroundColor Yellow
    foreach ($f in $blockedFiles) {
        Write-Host "  - $f" -ForegroundColor Red
    }
    Write-Host "Please remove these files from staging (git restore --staged <file>) or clear secrets before committing." -ForegroundColor Yellow
    exit 1
}

exit 0
