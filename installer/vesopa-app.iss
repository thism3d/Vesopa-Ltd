; One Inno Setup script for every Vesopa Windows app (2026-10-05).
;
; "I think exe with a private link for time being will be good. That allows
; us to control what versions people are on." (Nicki Tidbell)
;
; tool/build-installers.ps1 compiles it once per app with /D defines:
;   AppKey      till | kitchen | display | express | loyalty
;   AppName     what Windows shows ("Vesopa EPOS")
;   AppVersion  1.14.2
;   AppGuid     fixed per app; NEVER change one, or Windows treats the next
;               installer as a different program and a till gets two copies
;   ExeName     vesopa_epos.exe
;   SourceDir   the Flutter build (build\windows\x64\runner\Release)
;   OutputDir, OutputBase, IconFile
;   Scheme1, Scheme2  link schemes the Store copy registers in its manifest
;
; WHY PER USER. Installed under %LOCALAPPDATA%\Programs\Vesopa, with no
; administrator prompt, so the app can update itself silently when its venue
; is moved to another version (admin.vesopa.com Versions). A per-machine
; install would need an administrator at the till for every update.
;
; UP AND DOWN ARE THE SAME. Running any version's installer over another
; replaces the program and keeps the app's data (it lives in AppData, not in
; the program folder), which is how a venue is moved back.
;
; Silent, as the app runs it:  Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RELAUNCH=1

#ifndef AppKey
  #error Run tool\build-installers.ps1, which passes the defines.
#endif

[Setup]
AppId={{{#AppGuid}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Vesopa Software Ltd
AppPublisherURL=https://www.vesopaepos.com
AppSupportURL=https://www.vesopaepos.com
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Vesopa Software Ltd
VersionInfoProductName={#AppName}
DefaultDirName={autopf}\Vesopa\{#AppName}
DefaultGroupName=Vesopa
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#ExeName}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Close the running app (Restart Manager) rather than fail on a locked file.
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; A version moved back must not keep the newer one's files beside its own.
Type: filesandordirs; Name: "{app}\data"
Type: files; Name: "{app}\*.dll"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#ExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon

[Registry]
; The links the Store copy registers through its manifest (pubspec
; protocol_activation), registered for this user instead. Per user, so no
; administrator is needed, and removed on uninstall.
#ifdef Scheme1
Root: HKCU; Subkey: "Software\Classes\{#Scheme1}"; ValueType: string; ValueData: "URL:{#AppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#Scheme1}"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\{#Scheme1}\shell\open\command"; ValueType: string; ValueData: """{app}\{#ExeName}"" ""%1"""
#endif
#ifdef Scheme2
Root: HKCU; Subkey: "Software\Classes\{#Scheme2}"; ValueType: string; ValueData: "URL:{#AppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#Scheme2}"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\{#Scheme2}\shell\open\command"; ValueType: string; ValueData: """{app}\{#ExeName}"" ""%1"""
#endif

[Run]
; Offered on the last page when a person runs the installer.
Filename: "{app}\{#ExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; When the app updated itself, start it again.
Filename: "{app}\{#ExeName}"; Flags: nowait; Check: Relaunch

[UninstallDelete]
Type: files; Name: "{app}\vesopa-install.txt"

[Code]
function Relaunch: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:RELAUNCH|0}') = '1');
end;

// The app reads this to know it came from our installer (so it may update
// itself; a Store copy never does) and which version it really is
// (lib/data/app_update.dart).
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\vesopa-install.txt'), '{#AppVersion}', False);
end;
