#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

// One EPOS per Windows account (2026-10-17).
//
// The owner found two Vesopa EPOS windows open on the same machine. Two tills
// in one place are two copies of the open orders, the cash drawer and the
// card machine, each believing it is the only one. Opening the app a second
// time now brings the open window to the front and stops there, as the kiosk
// already does (vesopa_express/windows/runner/main.cpp).
//
// Named per user ("Local\"), so two people signed in to the same machine each
// keep their own till. Returns true when this process may carry on.
static bool ClaimSingleInstance(HANDLE *out_mutex) {
  *out_mutex = ::CreateMutexW(nullptr, TRUE, L"Local\\VesopaEpos.SingleInstance");
  if (*out_mutex == nullptr) {
    // Could not take the lock either way: start rather than leave a venue
    // with a till that will not open.
    return true;
  }
  if (::GetLastError() != ERROR_ALREADY_EXISTS) {
    return true;
  }
  HWND existing = ::FindWindowW(L"FLUTTER_RUNNER_WIN32_WINDOW", L"Vesopa EPOS");
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
  // The window caption, shown in the title bar, the taskbar tooltip and
  // Alt-Tab. Flutter seeds this from the pubspec package name, so it read
  // "vesopa_epos" — the project identifier, not the product.
  if (!window.Create(L"Vesopa EPOS", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
