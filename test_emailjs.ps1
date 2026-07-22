# Test script to verify the specific EmailJS IDs used by the app
# NOTE: these IDs must match window.SUPABASE_CONFIG in index.html (the inline <script>
# right before app.js is loaded) - that is the config actually used in production.
# The IDs previously hardcoded here (service_60jfsbe / template_fzzf45u) were STALE and
# did not match the live service (service_a1av3q9 / template_gyjh3gp), so this script was
# not actually testing what production uses.
$emailjsUrl = "https://api.emailjs.com/api/v1.0/email/send"

# Force TLS 1.2
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$body = @{
    service_id = "service_a1av3q9"
    template_id = "template_gyjh3gp"
    user_id = "1KO_vRCldTUVxoqtM"
    template_params = @{
        to_name = "Francess Test"
        to_email = "olipaq222@gmail.com"
        email = "olipaq222@gmail.com"
        subject = "PowerShell Integration Test"
    }
} | ConvertTo-Json -Depth 10

Write-Host "Sending request with IDs: service_a1av3q9, template_gyjh3gp..." -ForegroundColor Yellow
try {
    $headers = @{ "Content-Type" = "application/json" }
    $response = Invoke-WebRequest -Uri $emailjsUrl -Method Post -Headers $headers -Body $body -UseBasicParsing
    Write-Host "Success! Status Code: $($response.StatusCode)" -ForegroundColor Green
    Write-Host "Response Content: $($response.Content)" -ForegroundColor Green
} catch {
    Write-Host "Failed!" -ForegroundColor Red
    Write-Host "Error Details: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host "Response Body: $($reader.ReadToEnd())" -ForegroundColor Red
    }
}
