# Qualification-only native Win32 probe; SDK build, no downloaded binaries.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory,[ValidateSet('x64','ARM64')][string]$Architecture='x64')
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$vs=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$install=& $vs -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(!$install){throw 'Windows C++ SDK is required'}
$vc=Join-Path $install 'VC\Auxiliary\Build\vcvarsall.bat'
$source=Join-Path $PSScriptRoot 'oauth-credential-probe.c'
$batch=Join-Path $OutputDirectory 'build.cmd'
$lines=[System.Collections.Generic.List[string]]::new()
$lines.Add('@echo off')
$lines.Add('call "'+$vc+'" '+$Architecture+' >nul')
$lines.Add('if errorlevel 1 exit /b %errorlevel%')
$lines.Add('cd /d "'+$OutputDirectory+'"')
$lines.Add('cl.exe /nologo /W4 /MT /O2 "'+$source+'" /Fe:"'+(Join-Path $OutputDirectory 'credential-probe.exe')+'" /link advapi32.lib')
$lines.Add('exit /b %errorlevel%')
[IO.File]::WriteAllLines($batch,$lines)
& $env:ComSpec /d /c $batch
if($LASTEXITCODE -ne 0){throw 'Credential probe SDK build failed'}
