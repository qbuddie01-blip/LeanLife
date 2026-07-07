# Test script to verify EmailJS connectivity and TLS negotiation from PowerShell
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
        subject = "PowerShell Connectivity Test"
    }
} | ConvertTo-Json -Depth 10

Write-Host "Sending request via Invoke-RestMethod..." -ForegroundColor Yellow
try {
    $headers = @{ "Content-Type" = "application/json" }
    $response = Invoke-RestMethod -Uri $emailjsUrl -Method Post -Headers $headers -Body $body
    Write-Host "Success! Response: $response" -ForegroundColor Green
} catch {
    Write-Host "Failed!" -ForegroundColor Red
    Write-Host "Error Details: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host "Response Body: $($reader.ReadToEnd())" -ForegroundColor Red
    }
}
