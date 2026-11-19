param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Drawing
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

# Deliberately synthetic verification media; these are not creator reference videos.
$speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $speech.Rate = 0
  $speech.SetOutputToWaveFile([System.IO.Path]::Combine($OutputDirectory, 'speech.wav'))
  $speech.Speak('Welcome to Spur Ring. This is a video script test. The next shot shows a green background. Tomorrow we will create a new travel reel.')
} finally { $speech.Dispose() }

foreach ($scene in @(
  @{Name='scene-one.png';Color=[System.Drawing.Color]::RoyalBlue;Top='SPUR RING';Bottom='VIDEO SCRIPT TEST'},
  @{Name='scene-two.png';Color=[System.Drawing.Color]::ForestGreen;Top='TRAVEL';Bottom='TOMORROW'}
)) {
  $bitmap = [System.Drawing.Bitmap]::new(360, 640)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $font = [System.Drawing.Font]::new('Arial', 30, [System.Drawing.FontStyle]::Bold)
  $format = [System.Drawing.StringFormat]::new()
  try {
    $graphics.Clear($scene.Color)
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString($scene.Top, $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(15, 160, 330, 120), $format)
    $graphics.DrawString($scene.Bottom, $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(15, 340, 330, 160), $format)
    $bitmap.Save([System.IO.Path]::Combine($OutputDirectory, $scene.Name), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $format.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
Write-Output 'Synthetic speech and frame fixtures created.'
