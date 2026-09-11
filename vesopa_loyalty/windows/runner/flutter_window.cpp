#include "flutter_window.h"

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>

#include <optional>
#include <string>
#include <thread>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Networking.PushNotifications.h>

#include "flutter/generated_plugin_registrant.h"

namespace {

// A Windows notification channel for this installation, for the venue's
// notifications (lib/platform/push_io.dart). Windows draws the toast itself,
// so the app need not be running when one arrives.
//
// Asked for on a worker thread -- the call waits on the network -- and the
// answer is posted back to this window, because a Flutter method result must
// be completed on the platform thread.
constexpr UINT kWnsChannelReady = WM_APP + 0x51;

std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> g_wns_channel;
std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> g_wns_pending;

void AskForChannel(HWND window) {
  std::thread([window]() {
    auto* uri = new std::string();
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      auto channel = winrt::Windows::Networking::PushNotifications::
          PushNotificationChannelManager::
              CreatePushNotificationChannelForApplicationAsync()
                  .get();
      *uri = winrt::to_string(channel.Uri());
    } catch (...) {
      // Outside a Store package there is no identity to ask with; the app
      // says notifications are unavailable.
      uri->clear();
    }
    if (!PostMessage(window, kWnsChannelReady, 0,
                     reinterpret_cast<LPARAM>(uri))) {
      delete uri;
    }
  }).detach();
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());

  HWND window = GetHandle();
  g_wns_channel =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "vesopa_loyalty/wns",
          &flutter::StandardMethodCodec::GetInstance());
  g_wns_channel->SetMethodCallHandler(
      [window](const flutter::MethodCall<flutter::EncodableValue>& call,
               std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                   result) {
        if (call.method_name() != "channelUri") {
          result->NotImplemented();
          return;
        }
        if (g_wns_pending) {
          result->Error("busy", "Already asking Windows for a channel.");
          return;
        }
        g_wns_pending = std::move(result);
        AskForChannel(window);
      });

  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  g_wns_pending = nullptr;
  g_wns_channel = nullptr;
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  if (message == kWnsChannelReady) {
    std::unique_ptr<std::string> uri(reinterpret_cast<std::string*>(lparam));
    if (g_wns_pending) {
      if (uri->empty()) {
        g_wns_pending->Success();
      } else {
        g_wns_pending->Success(flutter::EncodableValue(*uri));
      }
      g_wns_pending = nullptr;
    }
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
