#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

// One kiosk per machine.
//
// Nothing stopped Vesopa Express being started twice, and on a kiosk that is
// not a harmless duplicate: every copy is a full-screen window with no title
// bar, so they stack, and the one on top is whichever started last. A manager
// who signs in on the copy underneath is told nothing -- the screen in front of
// them still says "Set up this kiosk", because it belongs to a different
// process that has no token. They press Continue with Vesopa again and
// commission the venue a second time.
//
// The mutex is named per user rather than globally: two people signed in to the
// same Windows machine (Assigned Access switches accounts) each get their own
// kiosk, which is the behaviour a venue would expect, and a global name would
// also fail on a terminal server for reasons nobody could see.
//
// Returns true when this process may carry on.
static bool ClaimSingleInstance(HANDLE *out_mutex) {
  *out_mutex = ::CreateMutexW(nullptr, TRUE, L"Local\\VesopaExpress.SingleInstance");
  if (*out_mutex == nullptr) {
    // Could not take the lock either way -- let the app start rather than
    // leaving a venue with a kiosk that refuses to open.
    return true;
  }
  if (::GetLastError() != ERROR_ALREADY_EXISTS) {
    return true;
  }

  // Somebody is already running. Put THAT window in front, so pressing the
  // icon a second time behaves like every other kiosk: it shows you the kiosk.
  HWND existing = ::FindWindowW(L"FLUTTER_RUNNER_WIN32_WINDOW", L"Vesopa Express");
  if (existing != nullptr) {
    if (::IsIconic(existing)) {
      ::ShowWindow(existing, SW_RESTORE);
    }
    ::SetForegroundWindow(existing);
  }
  ::CloseHandle(*out_mutex);
  *out_mutex = nullptr;
  return false;
}

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  HANDLE single_instance = nullptr;
  if (!ClaimSingleInstance(&single_instance)) {
    return EXIT_SUCCESS;
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"Vesopa Express", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  if (single_instance != nullptr) {
    ::ReleaseMutex(single_instance);
    ::CloseHandle(single_instance);
  }
  return EXIT_SUCCESS;
}
