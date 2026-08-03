#preproc ispp

#define MyAppName "NotoMixer"
#define MyAppPublisher "exertia Group"
#define MyAppExeName "NotoMixer.exe"
#define MyAppId "{{D80E3626-2877-4CA5-8D33-5F130238484F}"

#ifndef AppVersion
  #define AppVersion "1.0"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
AppCopyright=Copyright (C) 2026 {#MyAppPublisher}
LicenseFile=..\LICENSE
DefaultDirName={localappdata}\Programs\exertia\NotoMixer
DefaultGroupName=NotoMixer
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputDir=..\dist\installer
OutputBaseFilename=NotoMixer{#AppVersion}-win64Shipping
SetupIconFile=assets\NotoMixer.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardSmallImageFile=..\logo.png
WizardSmallImageBackColor=#101010
WizardImageFile=
WizardBackColor=#101010
WizardStyle=modern dark includetitlebar hidebevels
WizardSizePercent=110,110
DefaultDialogFontName=Segoe UI
Compression=lzma2/max
SolidCompression=yes
// Encryption=yes
// EncryptionKeyDerivation=pbkdf2/600000
// Password=exertia
// lit no point if i put this on github

PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=no
UsePreviousGroup=yes
UsePreviousTasks=yes
DisableWelcomePage=no
DisableReadyPage=no
DisableFinishedPage=no
AllowCancelDuringInstall=yes
SetupLogging=yes
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Installazione protetta di {#MyAppName}
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#AppVersion}

[Languages]
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"

[Tasks]
Name: "desktopicon"; Description: "Crea un collegamento sul &desktop"; GroupDescription: "Collegamenti:"

[Files]
Source: "..\dist\launcher\NotoMixer.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\app\NotoMixer-win32-x64\*"; DestDir: "{app}\reserved"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config.notomixer"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "..\assets\*"; DestDir: "{app}\assets"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs
Source: "..\logo.svg"; DestDir: "{app}\assets"; DestName: "logo.svg"; Flags: onlyifdoesntexist
Source: "..\logo.png"; DestDir: "{app}\assets"; DestName: "logo.png"; Flags: onlyifdoesntexist
Source: "..\settings\*"; DestDir: "{app}\settings"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\settings"
Name: "{app}\assets"
Name: "{app}\reserved"

[Icons]
Name: "{group}\NotoMixer"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\NotoMixer"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Avvia NotoMixer"; Flags: nowait postinstall skipifsilent

[Messages]
SetupWindowTitle=Installazione di %1
WelcomeLabel1=NotoMixer
WelcomeLabel2=Software by exertia Group%n%nQuesta procedura installerà [name/ver] sul computer.%n%nPremi Avanti per continuare.
PasswordLabel1=Installazione protetta
PasswordLabel3=Inserisci la password di installazione.
IncorrectPassword=Password non corretta. Riprova.
FinishedHeadingLabel=NotoMixer
FinishedLabel=L'installazione di [name] è stata completata correttamente.

[Code]
procedure InitializeWizard;
begin
  WizardForm.Caption := 'notoMixer Setup';
  WizardForm.WelcomeLabel1.Font.Name := 'Segoe UI';
  WizardForm.WelcomeLabel1.Font.Size := 28;
  WizardForm.WelcomeLabel1.Font.Style := [fsBold];
  WizardForm.WelcomeLabel2.Font.Name := 'Segoe UI';
  WizardForm.WelcomeLabel2.Font.Size := 10;
  WizardForm.FinishedHeadingLabel.Font.Name := 'Segoe UI';
  WizardForm.FinishedHeadingLabel.Font.Size := 22;
  WizardForm.FinishedHeadingLabel.Font.Style := [fsBold];
end;
