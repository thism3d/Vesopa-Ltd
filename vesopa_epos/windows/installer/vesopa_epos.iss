; Inno Setup script for the Windows till — produces "VesopaEPOS Installer.exe",
; the file the website links to at /app/VesopaEPOS%20Installer.exe.
;
; Compiled by CI (.github/workflows/windows.yml) after `flutter build windows`.
; To build it by hand, from the repository root:
;
;   flutter build windows --release
;   iscc windows\installer\vesopa_epos.iss
;
; The defines below have defaults so that plain `iscc` works locally; CI
; overrides AppVersion / VersionInfo from pubspec.yaml so the installer's
; version matches the app's.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef VersionInfo
  ; Windows wants four numeric parts here, unlike the display version.
  #define VersionInfo AppVersion + ".0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\windows\x64\runner\Release"
#endif

#define AppName "Vesopa EPOS"
#define AppExe "vesopa_epos.exe"
#define Publisher "Vesopa EPOS Ltd"
#define AppUrl "https://vesopaepos.com"

[Setup]
; Never change AppId: Windows uses it to recognise an existing install and
; upgrade it in place. A new GUID would install a second copy alongside the old.
AppId={{6FFDDB27-BEF1-4474-8B87-4296AB4F1E82}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/contact
VersionInfoVersion={#VersionInfo}
VersionInfoCompany={#Publisher}
VersionInfoDescription={#AppName} installer

DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
; One program-group name is enough for a till; nobody reorganises Start menus
; on a machine that runs one application.
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}

; Program Files needs elevation. Tills are set up by an engineer, and a
; per-machine install is what a shared counter machine wants — a per-user
; install would be invisible to the next Windows account that signs in.
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

; Refuses to overwrite files that are in use, and offers to close the till
; first, instead of leaving a half-updated install behind.
CloseApplications=yes
RestartApplications=no

OutputDir=..\..\build\windows\installer
OutputBaseFilename=VesopaEPOS Installer
SetupIconFile=..\runner\resources\app_icon.ico
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; The whole runner folder: the exe, flutter_windows.dll, the plugin DLLs and
; data\. Missing any one of them and the app starts and immediately dies.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Flutter writes its shader cache and plugin state next to the exe; without
; this the uninstall leaves the folder behind.
Type: filesandordirs; Name: "{app}"
