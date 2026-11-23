const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')

const run = promisify(execFile)
const discoverPrinterAndReader = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$reader = $null
foreach ($exe in @('AcroRd32.exe', 'Acrobat.exe')) {
  $reader = foreach ($root in @('HKCU:\Software', 'HKLM:\Software', 'HKLM:\Software\WOW6432Node')) {
    $key = Get-Item -LiteralPath "$root\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction SilentlyContinue
    if ($key) {
      $candidate = $key.GetValue('')
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $candidate }
    }
  }
  if ($reader) { break }
}
if (!$reader) {
  $reader = foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"))) {
    if (!$root) { continue }
    foreach ($relative in @('Adobe\Acrobat Reader DC\Reader\AcroRd32.exe', 'Adobe\Acrobat DC\Acrobat\Acrobat.exe')) {
      $candidate = Join-Path $root $relative
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
    }
  }
}
$printer = Get-Printer | Where-Object { $_.Name -eq $env:AROMAT_PRINT_DEVICE } | Select-Object -First 1
@{
  executable = @($reader)[0]
  driver = $printer.DriverName
  port = $printer.PortName
} | ConvertTo-Json -Compress
`

async function printWithAcrobat(file, deviceName) {
  const script = Buffer.from(discoverPrinterAndReader, 'utf16le').toString('base64')
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    env: { ...process.env, AROMAT_PRINT_DEVICE: deviceName },
    windowsHide: true,
    timeout: 15000
  })
  const { executable, driver, port } = JSON.parse(stdout.trim())
  if (!executable) return 'Adobe Acrobat Reader не найден. Откройте PDF и напечатайте его из Adobe.'
  if (!driver || !port) return 'Не удалось определить драйвер или порт выбранного принтера.'

  await new Promise((resolve, reject) => {
    const reader = spawn(executable, ['/t', file, deviceName, driver, port], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    reader.once('error', reject)
    reader.once('spawn', () => {
      reader.unref()
      resolve()
    })
  })
  return ''
}

module.exports = { printWithAcrobat }
