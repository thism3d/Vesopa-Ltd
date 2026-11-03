// Vesopa network helper: the few Windows changes a till needs an administrator
// for (restarting a network adapter, Bluetooth or a USB device, turning file
// and printer sharing on, marking the network private), done by a small
// service so staff are not asked for the administrator login every time.
//
// The owner chose this over a Windows prompt per restart (2026-11-03).
//
//   vesopa_nethelper.exe install    copies itself to Program Files, registers
//                                   and starts the service (the till runs this
//                                   once, elevated)
//   vesopa_nethelper.exe uninstall  stops and removes the service
//   (no argument)                   the service itself, started by Windows
//
// SAFETY. The service runs as LocalSystem, so it only does what is listed in
// Handle() below, with every argument checked (numbers are numbers, device ids
// carry no quotes or spaces). Anyone signed in at the PC may ask; nothing they
// can ask for reads data or runs a program of their choosing. It lives in
// Program Files, where only an administrator can replace it.

#include <windows.h>
#include <sddl.h>
#include <shlobj.h>

#include <cwctype>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kService[] = L"VesopaNetHelper";
constexpr wchar_t kDisplay[] = L"Vesopa network helper";
constexpr wchar_t kPipe[] = L"\\\\.\\pipe\\vesopa-nethelper";
// Bump with any change to what Handle() understands; the till offers to
// update the helper when its own copy is newer.
constexpr char kVersion[] = "1";

SERVICE_STATUS_HANDLE g_status_handle = nullptr;
SERVICE_STATUS g_status{};
HANDLE g_stop = nullptr;

std::wstring Widen(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::wstring SystemPath(const wchar_t* tail) {
  wchar_t dir[MAX_PATH];
  GetSystemDirectoryW(dir, MAX_PATH);
  return std::wstring(dir) + L"\\" + tail;
}

// Runs a Windows tool hidden and waits up to [ms]; returns its exit code, or
// -1 when it would not start or ran too long.
int Run(const std::wstring& exe, const std::wstring& args, DWORD ms = 60000) {
  std::wstring line = L"\"" + exe + L"\" " + args;
  STARTUPINFOW si{sizeof(si)};
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(exe.c_str(), line.data(), nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    return -1;
  }
  DWORD code = static_cast<DWORD>(-1);
  if (WaitForSingleObject(pi.hProcess, ms) == WAIT_OBJECT_0) {
    GetExitCodeProcess(pi.hProcess, &code);
  } else {
    TerminateProcess(pi.hProcess, 1);
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return static_cast<int>(code);
}

int PowerShell(const std::wstring& command) {
  return Run(SystemPath(L"WindowsPowerShell\\v1.0\\powershell.exe"),
             L"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + command + L"\"");
}

bool IsNumber(const std::string& s) {
  if (s.empty() || s.size() > 9) return false;
  for (char c : s) {
    if (c < '0' || c > '9') return false;
  }
  return true;
}

// A PnP instance id: USB\VID_04B8&PID_0202\5&2B1C... Letters, digits and the
// few marks ids use; no quote, space or anything a command line would read.
bool IsDeviceId(const std::string& s) {
  if (s.empty() || s.size() > 200) return false;
  for (char c : s) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                    c == '\\' || c == '&' || c == '_' || c == '#' || c == '{' || c == '}' ||
                    c == '.' || c == '-';
    if (!ok) return false;
  }
  return true;
}

std::string Result(int code) {
  return code == 0 ? "ok" : "error " + std::to_string(code);
}

// The firewall groups by their resource names, which read the same on a
// Welsh or a German Windows: File and Printer Sharing, Network Discovery.
constexpr wchar_t kFilesGroup[] = L"@FirewallAPI.dll,-28502";
constexpr wchar_t kDiscoveryGroup[] = L"@FirewallAPI.dll,-32752";

std::string Handle(const std::string& request) {
  std::vector<std::string> words;
  size_t start = 0;
  while (start < request.size()) {
    size_t end = request.find(' ', start);
    if (end == std::string::npos) end = request.size();
    if (end > start) words.push_back(request.substr(start, end - start));
    start = end + 1;
  }
  if (words.empty()) return "error empty";
  const std::string& cmd = words[0];
  const std::string arg = words.size() > 1 ? words[1] : std::string();
  const std::string arg2 = words.size() > 2 ? words[2] : std::string();

  if (cmd == "ping") return std::string("ok ") + kVersion;

  if (cmd == "adapter-restart" || cmd == "adapter-on" || cmd == "adapter-off") {
    if (!IsNumber(arg)) return "error bad adapter";
    const std::wstring verb = cmd == "adapter-restart" ? L"Restart-NetAdapter"
                              : cmd == "adapter-on"    ? L"Enable-NetAdapter"
                                                       : L"Disable-NetAdapter";
    return Result(PowerShell(L"Get-NetAdapter -InterfaceIndex " + Widen(arg) +
                             L" -ErrorAction Stop | " + verb + L" -Confirm:$false -ErrorAction Stop"));
  }

  if (cmd == "device-restart") {
    if (!IsDeviceId(arg)) return "error bad device";
    const int code = Run(SystemPath(L"pnputil.exe"), L"/restart-device \"" + Widen(arg) + L"\"");
    // 3010: restarted, but Windows wants the PC restarted to finish.
    return code == 3010 ? "ok reboot" : Result(code);
  }

  if (cmd == "sharing") {
    const wchar_t* group = arg == "files" ? kFilesGroup : arg == "discovery" ? kDiscoveryGroup : nullptr;
    if (!group || (arg2 != "on" && arg2 != "off")) return "error bad sharing";
    // Private networks only: a till on a public Wi-Fi keeps its files to itself.
    return Result(Run(SystemPath(L"netsh.exe"),
                      std::wstring(L"advfirewall firewall set rule group=\"") + group +
                          L"\" new enable=" + (arg2 == "on" ? L"Yes" : L"No") +
                          (arg2 == "on" ? L" profile=private" : L"")));
  }

  if (cmd == "network-private") {
    if (!IsNumber(arg)) return "error bad adapter";
    return Result(PowerShell(L"Set-NetConnectionProfile -InterfaceIndex " + Widen(arg) +
                             L" -NetworkCategory Private -ErrorAction Stop"));
  }

  return "error unknown";
}

// Signed-in users may read and write the pipe; SYSTEM and administrators own it.
PSECURITY_DESCRIPTOR PipeSecurity() {
  PSECURITY_DESCRIPTOR sd = nullptr;
  ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)", SDDL_REVISION_1, &sd, nullptr);
  return sd;
}

void Serve() {
  SECURITY_ATTRIBUTES sa{sizeof(sa), PipeSecurity(), FALSE};
  while (WaitForSingleObject(g_stop, 0) != WAIT_OBJECT_0) {
    HANDLE pipe = CreateNamedPipeW(kPipe, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                                   PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT |
                                       PIPE_REJECT_REMOTE_CLIENTS,
                                   1, 4096, 4096, 0, &sa);
    if (pipe == INVALID_HANDLE_VALUE) {
      Sleep(1000);
      continue;
    }
    OVERLAPPED ov{};
    ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    bool connected = ConnectNamedPipe(pipe, &ov) != FALSE;
    if (!connected) {
      const DWORD err = GetLastError();
      if (err == ERROR_PIPE_CONNECTED) {
        connected = true;
      } else if (err == ERROR_IO_PENDING) {
        HANDLE waits[] = {ov.hEvent, g_stop};
        connected = WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0;
        if (!connected) CancelIo(pipe);
      }
    }
    if (connected) {
      char buf[1024];
      DWORD read = 0;
      ResetEvent(ov.hEvent);
      BOOL ok = ReadFile(pipe, buf, sizeof(buf) - 1, &read, &ov);
      if (!ok && GetLastError() == ERROR_IO_PENDING) {
        ok = WaitForSingleObject(ov.hEvent, 10000) == WAIT_OBJECT_0 &&
             GetOverlappedResult(pipe, &ov, &read, FALSE);
      }
      if (ok && read > 0) {
        std::string request(buf, read);
        while (!request.empty() && (request.back() == '\n' || request.back() == '\r')) request.pop_back();
        const std::string reply = Handle(request) + "\n";
        DWORD wrote = 0;
        ResetEvent(ov.hEvent);
        if (!WriteFile(pipe, reply.data(), static_cast<DWORD>(reply.size()), &wrote, &ov) &&
            GetLastError() == ERROR_IO_PENDING) {
          WaitForSingleObject(ov.hEvent, 5000);
        }
        FlushFileBuffers(pipe);
      }
      DisconnectNamedPipe(pipe);
    }
    CloseHandle(ov.hEvent);
    CloseHandle(pipe);
  }
  LocalFree(sa.lpSecurityDescriptor);
}

void SetState(DWORD state) {
  g_status.dwCurrentState = state;
  g_status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  SetServiceStatus(g_status_handle, &g_status);
}

DWORD WINAPI Control(DWORD control, DWORD, LPVOID, LPVOID) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    SetState(SERVICE_STOP_PENDING);
    SetEvent(g_stop);
  }
  return NO_ERROR;
}

void WINAPI ServiceMain(DWORD, LPWSTR*) {
  g_status_handle = RegisterServiceCtrlHandlerExW(kService, Control, nullptr);
  if (!g_status_handle) return;
  g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  SetState(SERVICE_RUNNING);
  Serve();
  SetState(SERVICE_STOPPED);
}

std::wstring InstalledPath() {
  PWSTR pf = nullptr;
  SHGetKnownFolderPath(FOLDERID_ProgramFiles, 0, nullptr, &pf);
  std::wstring dir = std::wstring(pf) + L"\\Vesopa\\Network Helper";
  CoTaskMemFree(pf);
  return dir;
}

bool StopService(SC_HANDLE service) {
  SERVICE_STATUS s{};
  ControlService(service, SERVICE_CONTROL_STOP, &s);
  for (int i = 0; i < 50; i++) {
    if (!QueryServiceStatus(service, &s) || s.dwCurrentState == SERVICE_STOPPED) return true;
    Sleep(200);
  }
  return false;
}

int Install() {
  wchar_t self[MAX_PATH];
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  const std::wstring dir = InstalledPath();
  SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
  const std::wstring target = dir + L"\\vesopa_nethelper.exe";

  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) return 2;
  SC_HANDLE service = OpenServiceW(scm, kService, SERVICE_ALL_ACCESS);
  if (service) StopService(service);
  if (_wcsicmp(self, target.c_str()) != 0 && !CopyFileW(self, target.c_str(), FALSE)) {
    if (service) CloseServiceHandle(service);
    CloseServiceHandle(scm);
    return 3;
  }
  const std::wstring bin = L"\"" + target + L"\"";
  if (service) {
    ChangeServiceConfigW(service, SERVICE_NO_CHANGE, SERVICE_AUTO_START, SERVICE_NO_CHANGE,
                         bin.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr, kDisplay);
  } else {
    service = CreateServiceW(scm, kService, kDisplay, SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
                             SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, bin.c_str(), nullptr,
                             nullptr, nullptr, nullptr, nullptr);
    if (!service) {
      CloseServiceHandle(scm);
      return 4;
    }
  }
  SERVICE_DESCRIPTIONW desc{const_cast<LPWSTR>(
      L"Lets Vesopa EPOS restart this PC's network adapters, Bluetooth and USB devices, and "
      L"turn file and printer sharing on, without asking for the administrator login each time.")};
  ChangeServiceConfig2W(service, SERVICE_CONFIG_DESCRIPTION, &desc);
  // Back up by itself if it ever stops unexpectedly.
  SC_ACTION actions[] = {{SC_ACTION_RESTART, 5000}, {SC_ACTION_RESTART, 30000}, {SC_ACTION_NONE, 0}};
  SERVICE_FAILURE_ACTIONSW failure{86400, nullptr, nullptr, 3, actions};
  ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, &failure);
  const bool started = StartServiceW(service, 0, nullptr) || GetLastError() == ERROR_SERVICE_ALREADY_RUNNING;
  CloseServiceHandle(service);
  CloseServiceHandle(scm);
  return started ? 0 : 5;
}

int Uninstall() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) return 2;
  SC_HANDLE service = OpenServiceW(scm, kService, SERVICE_ALL_ACCESS);
  if (service) {
    StopService(service);
    DeleteService(service);
    CloseServiceHandle(service);
  }
  CloseServiceHandle(scm);
  DeleteFileW((InstalledPath() + L"\\vesopa_nethelper.exe").c_str());
  RemoveDirectoryW(InstalledPath().c_str());
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc > 1 && _wcsicmp(argv[1], L"install") == 0) return Install();
  if (argc > 1 && _wcsicmp(argv[1], L"uninstall") == 0) return Uninstall();
  SERVICE_TABLE_ENTRYW table[] = {{const_cast<LPWSTR>(kService), ServiceMain}, {nullptr, nullptr}};
  return StartServiceCtrlDispatcherW(table) ? 0 : 1;
}
