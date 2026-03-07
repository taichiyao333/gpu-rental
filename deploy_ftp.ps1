###############################################################
#  GPU Rental Platform - FTP Deploy Script
#  Target: mdl-japan.sakura.ne.jp /www/gpurental/
###############################################################
param(
    [string]$ApiBase = "REPLACE_WITH_TUNNEL_URL",  # e.g. https://xxxx.trycloudflare.com
    [switch]$DryRun = $false
)

$FTP_HOST = "mdl-japan.sakura.ne.jp"
$FTP_USER = "mdl-japan"
$FTP_PASS = "UDM.r7K9Hy33"
$FTP_REMOTE = "/www/gpurental"
$LOCAL_PUBLIC = "F:\antigravity\gpu-platform\public"
$CRED = New-Object System.Net.NetworkCredential($FTP_USER, $FTP_PASS)

# Files to upload (relative to $LOCAL_PUBLIC)
$UPLOAD_DIRS = @("landing", "portal", "admin", "workspace", "provider")

function Ensure-FtpDir($url) {
    try {
        $req = [System.Net.FtpWebRequest]::Create($url)
        $req.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
        $req.Credentials = $CRED
        $req.Timeout = 10000
        $req.GetResponse() | Out-Null
        Write-Host "  Created dir: $url"
    } catch {
        # Already exists is fine (550 error)
    }
}

function Upload-File($localPath, $remoteUrl) {
    $bytes = [System.IO.File]::ReadAllBytes($localPath)
    $req = [System.Net.FtpWebRequest]::Create($remoteUrl)
    $req.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
    $req.Credentials = $CRED
    $req.ContentLength = $bytes.Length
    $req.Timeout = 60000
    $req.UseBinary = $true
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $req.GetResponse() | Out-Null
}

###############################################################
# Step 1: Patch API base URL in frontend JS files
###############################################################
Write-Host "`n[1/4] Patching API base URL in frontend JS..."
$tempDir = "F:\antigravity\gpu-platform\tmp_deploy"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
Copy-Item $LOCAL_PUBLIC $tempDir -Recurse

$jsFiles = Get-ChildItem "$tempDir" -Recurse -Filter "*.js" |
    Where-Object { $_.FullName -notmatch "node_modules" }

foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    $changed = $false

    # Replace relative API path with absolute backend URL
    if ($content -match "const API = ''" -or $content -match 'const API=""') {
        $content = $content -replace "const API = ''", "const API = '$ApiBase'"
        $content = $content -replace 'const API=""', "const API = '$ApiBase'"
        $changed = $true
    }
    # socket.io connection (relative -> absolute)
    if ($content -match "io\(\)") {
        $content = $content -replace "io\(\)", "io('$ApiBase')"
        $changed = $true
    }
    if ($changed) {
        Set-Content -Path $f.FullName -Value $content -Encoding UTF8
        Write-Host "  Patched: $($f.Name)"
    }
}

# Create top-level index.html that redirects to /gpurental/landing/
$indexHtml = @"
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=landing/">
<title>GPU Rental Platform</title>
</head><body>
<p><a href="landing/">GPU Rental Platform</a></p>
</body></html>
"@
Set-Content "$tempDir\index.html" $indexHtml -Encoding UTF8

Write-Host "`n[2/4] Creating FTP directories..."

$baseUrl = "ftp://$FTP_HOST$FTP_REMOTE"
Ensure-FtpDir "$baseUrl/"
foreach ($dir in $UPLOAD_DIRS) {
    Ensure-FtpDir "$baseUrl/$dir/"
    # Check for subdirs (e.g. landing might have subfolders)
    $subDirs = Get-ChildItem "$tempDir\$dir" -Directory -Recurse
    foreach ($sd in $subDirs) {
        $rel = $sd.FullName.Replace("$tempDir\$dir\", "").Replace("\", "/")
        Ensure-FtpDir "$baseUrl/$dir/$rel/"
    }
}

Write-Host "`n[3/4] Uploading files..."
$totalFiles = 0
$failFiles = 0

# Upload root index.html
if (-not $DryRun) {
    try {
        Upload-File "$tempDir\index.html" "$baseUrl/index.html"
        Write-Host "  -> index.html"
        $totalFiles++
    } catch { Write-Host "  FAIL index.html: $_"; $failFiles++ }
}

foreach ($dir in $UPLOAD_DIRS) {
    $localDir = "$tempDir\$dir"
    if (-not (Test-Path $localDir)) { continue }
    
    $files = Get-ChildItem $localDir -Recurse -File
    foreach ($file in $files) {
        $rel = $file.FullName.Replace("$tempDir\$dir\", "").Replace("\", "/")
        $remoteUrl = "$baseUrl/$dir/$rel"
        $fileSize = [math]::Round($file.Length / 1KB, 1)
        
        if ($DryRun) {
            Write-Host "  [DRY] $dir/$rel ($fileSize KB)"
        } else {
            try {
                Upload-File $file.FullName $remoteUrl
                Write-Host "  -> $dir/$rel ($fileSize KB)"
                $totalFiles++
            } catch {
                Write-Host "  FAIL $dir/$rel : $_"
                $failFiles++
            }
        }
    }
}

Write-Host "`n[4/4] Cleanup..."
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n============================================"
Write-Host "  Deploy Complete!"
Write-Host "  Uploaded: $totalFiles files"
if ($failFiles -gt 0) { Write-Host "  Failed  : $failFiles files" }
Write-Host "  URL: https://gpurental.jp/gpurental/"
Write-Host "============================================"
