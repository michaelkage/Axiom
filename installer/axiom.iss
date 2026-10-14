; Axiom extension installer. The VSIX remains available for manual installation if CLI detection fails.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef VsixFile
  #define VsixFile "axiom.vsix"
#endif
#ifndef OutputDir
  #define OutputDir "dist-release"
#endif
#ifndef VsixPath
  #define VsixPath "dist-release\\axiom.vsix"
#endif

[Setup]
AppId={{B88A6B6B-1F27-4A9C-8B50-A71000000001}
AppName=Axiom
AppVersion={#AppVersion}
AppPublisher=Axiom
DefaultDirName={localappdata}\Axiom
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=Axiom-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
Uninstallable=no
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#OutputDir}\{#VsixFile}"; DestDir: "{app}"; DestName: "axiom-{#AppVersion}.vsix"; Flags: ignoreversion


[Code]
function TryInstallVSIX(const CliPath, VsixPath: string): Boolean;
var
  ResultCode: Integer;
  Params: string;
begin
  Params := '/C ""' + CliPath + '" --install-extension "' + VsixPath + '" --force"';
  Result := Exec(ExpandConstant('{sys}\\cmd.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    and (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  VsixPath, LocalCli, SystemCli: string;
begin
  if CurStep <> ssPostInstall then
    exit;

  VsixPath := ExpandConstant('{app}\axiom-{#AppVersion}.vsix');
  LocalCli := ExpandConstant('{localappdata}\Programs\Microsoft VS Code\bin\code.cmd');
  SystemCli := ExpandConstant('{pf}\Microsoft VS Code\bin\code.cmd');

  if FileExists(LocalCli) and TryInstallVSIX(LocalCli, VsixPath) then
  begin
    MsgBox('Axiom was installed into Visual Studio Code.' + #13#10 +
      'Restart or reload VS Code to activate it.', mbInformation, MB_OK);
    exit;
  end;

  if FileExists(SystemCli) and TryInstallVSIX(SystemCli, VsixPath) then
  begin
    MsgBox('Axiom was installed into Visual Studio Code.' + #13#10 +
      'Restart or reload VS Code to activate it.', mbInformation, MB_OK);
    exit;
  end;

  MsgBox('The Axiom VSIX was saved here:' + #13#10 + VsixPath + #13#10#13#10 +
    'VS Code CLI was not found or installation did not complete. In VS Code, open Extensions, choose "Install from VSIX...", and select this file.',
    mbInformation, MB_OK);
end;
