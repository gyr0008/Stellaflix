# sapi-transcribe.ps1
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File sapi-transcribe.ps1 <wavPath>
# Exit codes:
#   0 = success (stdout = recognized text, possibly empty)
#   2 = WAV not found
#   3 = System.Speech assembly missing
#   4 = No speech recognizer installed
#   5 = Recognize() threw
param([Parameter(Mandatory=$true)][string]$WavPath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $WavPath)) {
    [Console]::Error.WriteLine("WAV_NOT_FOUND: $WavPath")
    exit 2
}

try {
    Add-Type -AssemblyName System.Speech
} catch {
    [Console]::Error.WriteLine("SYSTEM_SPEECH_MISSING")
    exit 3
}

$engine = $null
$engineLang = ''
foreach ($c in @('zh-CN', 'en-US')) {
    try {
        $ci = New-Object System.Globalization.CultureInfo($c)
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ci)
        $engineLang = $c
        break
    } catch {
        $engine = $null
    }
}
if (-not $engine) {
    try {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
        $engineLang = 'default'
    } catch {
        [Console]::Error.WriteLine("NO_SPEECH_RECOGNIZER")
        exit 4
    }
}

try {
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $engine.LoadGrammar($grammar)
    $engine.SetInputToWaveFile((Resolve-Path -LiteralPath $WavPath))
    $result = $engine.Recognize()
    if ($result -and $result.Text) {
        [Console]::Out.Write($result.Text)
    }
    exit 0
} catch {
    [Console]::Error.WriteLine("RECOGNIZE_FAILED: $($_.Exception.Message)")
    exit 5
} finally {
    if ($engine) { try { $engine.Dispose() } catch {} }
}