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
                $headers = @{ "Content-Type" = "application/json" }
                
                # Force TLS 1.2 on this thread request
                [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
                
                $relayResponse = Invoke-WebRequest -Uri $emailjsUrl -Method Post -Headers $headers -Body $body -UseBasicParsing
                
                $response.StatusCode = $relayResponse.StatusCode
                $response.ContentType = "text/plain"
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes($relayResponse.Content)
                $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
            } catch {
                $response.StatusCode = 412
                $response.ContentType = "text/plain"
                $errDetails = $_.Exception.Message
                
                try {
                    if ($_.Exception.Response) {
                        $resStream = $_.Exception.Response.GetResponseStream()
                        if ($resStream) {
                            $errReader = New-Object System.IO.StreamReader($resStream)
                            $errDetails = $errReader.ReadToEnd()
                            $errReader.Close()
                        }
                    }
                } catch {
                    # Fallback to exception message if response stream fails to read
                }
                
                Write-Host "❌ Email Relay Error: $errDetails" -ForegroundColor Red
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
