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

const script = Buffer.from(discoverPrinterAndReader, 'utf16le').toString('base64')
const targetCache = new Map()
const cacheLifetime = 5 * 60 * 1000

async function lookupTarget(deviceName) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    env: { ...process.env, AROMAT_PRINT_DEVICE: deviceName },
    windowsHide: true,
    timeout: 15000
  })
  return JSON.parse(stdout.trim())
}

function prepareAcrobat(deviceName, refresh = false) {
  const cached = targetCache.get(deviceName)
  if (!refresh && cached?.expiresAt > Date.now()) return cached.ready

  const target = { expiresAt: Infinity }
  target.ready = lookupTarget(deviceName).then((result) => {
    target.expiresAt = Date.now() + cacheLifetime
    if (!result.executable || !result.driver || !result.port) target.expiresAt = 0
    return result
  }, (error) => {
    target.expiresAt = 0
    throw error
  })
  targetCache.set(deviceName, target)
  return target.ready
}

async function printWithAcrobat(file, deviceName, { executable, driver, port }) {
  if (!executable) return 'Adobe Acrobat Reader не найден. Откройте PDF и напечатайте его из Adobe.'
  if (!driver || !port) return 'Не удалось определить драйвер или порт выбранного принтера.'

  await new Promise((resolve, reject) => {
    const reader = spawn(executable, ['/t', file, deviceName, driver, port], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    reader.once('error', (error) => {
      targetCache.delete(deviceName)
      reject(error)
    })
    reader.once('spawn', () => {
      reader.unref()
      resolve()
    })
  })
  return ''
}

module.exports = { prepareAcrobat, printWithAcrobat }
