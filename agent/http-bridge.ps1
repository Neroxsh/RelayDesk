$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-ProtocolResult($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 10))
  [Console]::Out.Flush()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $headers = @{}
    foreach ($property in $request.headers.PSObject.Properties) {
      $headers[$property.Name] = [string]$property.Value
    }
    $parameters = @{
      Uri = [string]$request.url
      Method = [string]$request.method
      Headers = $headers
      UseBasicParsing = $true
      ErrorAction = "Stop"
    }
    if ($null -ne $request.body) {
      $parameters["ContentType"] = "application/json"
      $parameters["Body"] = [string]$request.body
    }
    $response = Invoke-WebRequest @parameters
    Write-ProtocolResult @{
      id = $request.id
      status = [int]$response.StatusCode
      body = [string]$response.Content
    }
  } catch {
    $status = 0
    $body = ""
    if ($_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = 0 }
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Dispose()
      } catch { $body = "" }
    }
    Write-ProtocolResult @{
      id = if ($request) { $request.id } else { -1 }
      status = $status
      body = $body
      error = [string]$_.Exception.Message
    }
  }
}
