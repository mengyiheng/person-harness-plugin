param([string]$Title64, [string]$Message64)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Title64))
$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Message64))
$result = [System.Windows.MessageBox]::Show($message, $title, [System.Windows.MessageBoxButton]::YesNo, [System.Windows.MessageBoxImage]::Question)
if ($result -eq [System.Windows.MessageBoxResult]::Yes) { exit 0 }
exit 1
