// vesopa_start.exe: what the till's icon opens (Pontardawe RFC, 2026-11-07).
//
// A till that has lost one of its own files (screen_retriever_windows_plugin.dll
// went missing after an update) cannot start at all: Windows refuses the
// program before any of its code runs, so the till cannot mend itself. This
// starts it instead, and checks first:
//
//   1. Every file the build shipped (vesopa-files.txt, written at build time:
//      path and size) is here and the right size.
//   2. If so, it starts vesopa_epos.exe with the same arguments and is done.
//   3. If not, it runs the installer that this very version left on this
//      computer (%LOCALAPPDATA%\Vesopa\Repair\till\setup.exe, installer/
//      vesopa-app.iss), silently, which puts every file back and starts the
//      till. No download, no internet, nobody has to find the installer.
//   4. Only if that copy is missing too, or a repair was tried a moment ago,
//      does it say what is wrong and where to get the installer.
//
// Plain Win32 with the C runtime built in (/MT, see CMakeLists.txt): it needs
// nothing but Windows itself, so it cannot be stopped by a missing file.

#include <windows.h>
#include <shlobj.h>

#include <fstream>
#include <string>
#include <vector>

namespace {

std::wstring Folder() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  std::wstring p(path, n);
  return p.substr(0, p.find_last_of(L"\\/"));
}

std::wstring Widen(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}

// The files that are missing or the wrong size; empty when all is well or
// when there is no list to check against (an older build).
std::vector<std::wstring> Missing(const std::wstring& dir) {
  std::vector<std::wstring> bad;
  std::ifstream list(dir + L"\\vesopa-files.txt");
  if (!list) return bad;
  std::string line;
  while (std::getline(list, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto bar = line.rfind('|');
    if (bar == std::string::npos) continue;
    std::wstring rel = Widen(line.substr(0, bar));
    long long want = _atoi64(line.substr(bar + 1).c_str());
    WIN32_FILE_ATTRIBUTE_DATA fa;
    if (!GetFileAttributesExW((dir + L"\\" + rel).c_str(), GetFileExInfoStandard, &fa)) {
      bad.push_back(rel);
      continue;
    }
    long long size = ((long long)fa.nFileSizeHigh << 32) | fa.nFileSizeLow;
    if (want > 0 && size != want) bad.push_back(rel);
  }
  return bad;
}

std::wstring RepairFolder() {
  wchar_t* local = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) {
    out = std::wstring(local) + L"\\Vesopa\\Repair\\till";
  }
  CoTaskMemFree(local);
  return out;
}

bool Exists(const std::wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }

// A repair tried in the last ten minutes that did not help: do not loop.
bool TriedLately(const std::wstring& marker) {
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (!GetFileAttributesExW(marker.c_str(), GetFileExInfoStandard, &fa)) return false;
  FILETIME now;
  GetSystemTimeAsFileTime(&now);
  ULARGE_INTEGER a, b;
  a.LowPart = fa.ftLastWriteTime.dwLowDateTime;
  a.HighPart = fa.ftLastWriteTime.dwHighDateTime;
  b.LowPart = now.dwLowDateTime;
  b.HighPart = now.dwHighDateTime;
  return b.QuadPart > a.QuadPart && (b.QuadPart - a.QuadPart) < 10ULL * 60 * 10000000ULL;
}

bool Run(const std::wstring& exe, const std::wstring& args, const std::wstring& dir) {
  std::wstring cmd = L"\"" + exe + L"\" " + args;
  STARTUPINFOW si{sizeof(si)};
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, FALSE, 0, nullptr, dir.c_str(), &si, &pi)) return false;
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE, HINSTANCE, wchar_t*, int) {
  const std::wstring dir = Folder();
  const std::wstring app = dir + L"\\vesopa_epos.exe";

  // Whatever the icon or a link passed on goes to the till as it is.
  std::wstring args;
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; ++i) args += L"\"" + std::wstring(argv[i]) + L"\" ";
  if (argv) LocalFree(argv);

  auto bad = Missing(dir);
  if (bad.empty() && Exists(app)) {
    return Run(app, args, dir) ? 0 : 1;
  }

  const std::wstring repair = RepairFolder();
  const std::wstring setup = repair + L"\\setup.exe";
  const std::wstring marker = repair + L"\\repair-tried.txt";
  if (!repair.empty() && Exists(setup) && !TriedLately(marker)) {
    std::wofstream(marker) << L"missing: " << (bad.empty() ? L"vesopa_epos.exe" : bad.front()) << L"\n";
    // The installer puts every file back and starts the till (/RELAUNCH=1).
    if (Run(setup, L"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RELAUNCH=1", repair)) return 0;
  }

  std::wstring what = bad.empty() ? L"vesopa_epos.exe" : bad.front();
  std::wstring msg = L"Vesopa EPOS cannot start: " + what +
                     L" is missing.\n\nRun the Vesopa EPOS installer from admin.vesopa.com/downloads "
                     L"to put it back. Your sales and settings are kept.";
  MessageBoxW(nullptr, msg.c_str(), L"Vesopa EPOS", MB_OK | MB_ICONERROR);
  return 2;
}
