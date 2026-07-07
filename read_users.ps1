$url = "https://vqvbxhzxtwjhieihvoah.supabase.co/rest/v1/system_settings?id=eq.leanlife_cloud_db&select=data"
$headers = @{
    "apikey" = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdmJ4aHp4dHdqaGllaWh2b2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDU1NDAsImV4cCI6MjA5ODk4MTU0MH0.40ItPbKKZihVJ6IgC2BMU_cGO4pOzQFD-6-QkxEuZTk"
    "Authorization" = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdmJ4aHp4dHdqaGllaWh2b2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDU1NDAsImV4cCI6MjA5ODk4MTU0MH0.40ItPbKKZihVJ6IgC2BMU_cGO4pOzQFD-6-QkxEuZTk"
}

$response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
if ($response) {
    $db = $response.data
    Write-Host "--- SUPABASE USERS LIST ---" -ForegroundColor Green
    foreach ($user in $db.users) {
        Write-Host "Name: $($user.name)"
        Write-Host "Email: $($user.email)"
        Write-Host "Password Hash: $($user.password)"
        Write-Host "Role: $($user.role)"
        Write-Host "First Login: $($user.firstLogin)"
        Write-Host "---------------------------"
    }
} else {
    Write-Host "No database found in Supabase." -ForegroundColor Red
}
