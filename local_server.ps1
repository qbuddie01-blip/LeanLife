# Lightweight Zero-Dependency PowerShell HTTP Server
# Serves static files locally to bypass browser CORS / null-origin restrictions on file://

# Force TLS 1.2 security protocol for outbound web requests
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$port = 8081
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    Write-Host "⚡ Zero-Dependency Server running at http://localhost:$port/index.html" -ForegroundColor Green
    Write-Host "Keep this window open. Close it to stop the server." -ForegroundColor Yellow
    
    # Open the browser to localhost
    Start-Process "http://localhost:$port/index.html"
    
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $urlPath = $request.Url.LocalPath
        
        # EmailJS Proxy handler to bypass browser blocks
        if ($urlPath -eq "/send_email_api") {
            try {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Close()
                
                $emailjsUrl = "https://api.emailjs.com/api/v1.0/email/send"
                
                # Write the JSON payload to a temporary file in the workspace
                $tempFile = Join-Path $PSScriptRoot "temp_payload.json"
                [System.IO.File]::WriteAllText($tempFile, $body, [System.Text.Encoding]::UTF8)
                
                # Execute curl.exe (built-in to Windows 10/11) to bypass .NET TLS limitations
                $curlOutput = & curl.exe -s -i -X POST $emailjsUrl -H "Content-Type: application/json" --data-binary "@$tempFile"
                
                # Clean up the temp file
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
                
                # Parse the HTTP status code from curl output (e.g. HTTP/1.1 200 OK)
                $statusCode = 200
                if ($curlOutput -match "HTTP/\d\.\d\s+(\d+)") {
                    $statusCode = [int]$Matches[1]
                }
                
                # Extract the body content (skip the headers)
                $bodyIndex = $curlOutput.IndexOf("`r`n`r`n")
                $resBody = "OK"
                if ($bodyIndex -ge 0) {
                    $resBody = $curlOutput.Substring($bodyIndex + 4)
                }
                
                $response.StatusCode = $statusCode
                $response.ContentType = "text/plain"
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resBody)
                $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
            } catch {
                $response.StatusCode = 412
                $response.ContentType = "text/plain"
                $errDetails = $_.Exception.Message
                if ($_.Exception.Response) {
                    $errReader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                    $errDetails = $errReader.ReadToEnd()
                    $errReader.Close()
                }
                $errBytes = [System.Text.Encoding]::UTF8.GetBytes($errDetails)
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
            }
            $response.Close()
            continue
        }
        
        if ($urlPath -eq "/" -or $urlPath -eq "") { $urlPath = "/index.html" }
        
        # Translate URL path to local absolute file path
        $cleanPath = $urlPath.Replace('/', '\').TrimStart('\')
        $filePath = Join-Path $PSScriptRoot $cleanPath
        
        # Security check: prevent directory traversal
        if (-not $filePath.StartsWith($PSScriptRoot)) {
            $response.StatusCode = 403
            $response.Close()
            continue
        }

        if (Test-Path $filePath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            
            # Match standard web MIME types
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $contentType = "text/plain"
            switch ($ext) {
                ".html" { $contentType = "text/html; charset=utf-8" }
                ".css"  { $contentType = "text/css; charset=utf-8" }
                ".js"   { $contentType = "application/javascript; charset=utf-8" }
                ".png"  { $contentType = "image/png" }
                ".jpg"  { $contentType = "image/jpeg" }
                ".jpeg" { $contentType = "image/jpeg" }
                ".svg"  { $contentType = "image/svg+xml" }
                ".ico"  { $contentType = "image/x-icon" }
                ".json" { $contentType = "application/json; charset=utf-8" }
            }
            
            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            # File not found
            $response.StatusCode = 404
            $response.ContentType = "text/plain"
            $errMsg = [System.Text.Encoding]::UTF8.GetBytes("404 File Not Found")
            $response.OutputStream.Write($errMsg, 0, $errMsg.Length)
        }
        $response.Close()
    }
} catch {
    Write-Host "Error running server: $_" -ForegroundColor Red
} finally {
    $listener.Close()
}
