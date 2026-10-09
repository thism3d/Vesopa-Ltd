#include "store_update.h"

#include <unknwn.h>
#include <shobjidl_core.h>

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>

#include <cstdint>
#include <memory>
#include <string>
#include <thread>

#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>

namespace store_update {
namespace {

using flutter::EncodableMap;
using flutter::EncodableValue;
using winrt::Windows::Services::Store::StoreContext;
using winrt::Windows::Services::Store::StorePackageUpdate;
using winrt::Windows::Services::Store::StorePackageUpdateResult;
using winrt::Windows::Services::Store::StorePackageUpdateState;

// The Store answers on a worker thread (each call waits on the network); the
// answer is posted back to the window, because a Flutter method result must
// be completed on the platform thread.
constexpr UINT kStoreAnswer = WM_APP + 0x53;

std::unique_ptr<flutter::MethodChannel<EncodableValue>> g_channel;
HWND g_window = nullptr;

struct Answer {
  std::unique_ptr<flutter::MethodResult<EncodableValue>> result;
  EncodableValue value;
};

void Post(HWND window, Answer* answer) {
  if (!PostMessage(window, kStoreAnswer, 0,
                   reinterpret_cast<LPARAM>(answer))) {
    delete answer;
  }
}

bool Packaged() {
  try {
    const auto package = winrt::Windows::ApplicationModel::Package::Current();
    return package != nullptr;
  } catch (...) {
    return false;
  }
}

uint64_t Packed(StorePackageUpdate const& update) {
  const auto v = update.Package().Id().Version();
  return (static_cast<uint64_t>(v.Major) << 48) |
         (static_cast<uint64_t>(v.Minor) << 32) |
         (static_cast<uint64_t>(v.Build) << 16) | v.Revision;
}

std::string Dotted(uint64_t v) {
  return std::to_string((v >> 48) & 0xFFFF) + "." +
         std::to_string((v >> 32) & 0xFFFF) + "." +
         std::to_string((v >> 16) & 0xFFFF) + "." + std::to_string(v & 0xFFFF);
}

void Check(HWND window, Answer* answer) {
  std::thread([window, answer]() {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      if (Packaged()) {
        const auto updates =
            StoreContext::GetDefault()
                .GetAppAndOptionalStorePackageUpdatesAsync()
                .get();
        uint64_t newest = 0;
        for (auto const& update : updates) {
          const auto v = Packed(update);
          if (v > newest) newest = v;
        }
        EncodableMap map;
        map[EncodableValue("available")] = EncodableValue(updates.Size() > 0);
        map[EncodableValue("version")] =
            EncodableValue(newest ? Dotted(newest) : std::string());
        answer->value = EncodableValue(map);
      }
    } catch (...) {
      // No Store, no network, no package: nothing to say this time.
    }
    Post(window, answer);
  }).detach();
}

void Install(HWND window, Answer* answer) {
  std::thread([window, answer]() {
    std::string state = "failed";
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      auto context = StoreContext::GetDefault();
      // A desktop app names its window, or the Store has nothing to show a
      // consent dialog over.
      context.as<::IInitializeWithWindow>()->Initialize(window);
      const auto updates =
          context.GetAppAndOptionalStorePackageUpdatesAsync().get();
      if (updates.Size() == 0) {
        state = "none";
      } else {
        // Windows closes the app to replace it; this brings it back.
        RegisterApplicationRestart(L"", 0);
        StorePackageUpdateResult result{nullptr};
        if (context.CanSilentlyDownloadStorePackageUpdates()) {
          result =
              context.TrySilentDownloadAndInstallStorePackageUpdatesAsync(
                         updates)
                  .get();
        } else {
          result =
              context.RequestDownloadAndInstallStorePackageUpdatesAsync(updates)
                  .get();
        }
        switch (result.OverallState()) {
          case StorePackageUpdateState::Completed:
            state = "completed";
            break;
          case StorePackageUpdateState::Canceled:
            state = "canceled";
            break;
          default:
            state = "failed";
        }
      }
    } catch (...) {
      state = "failed";
    }
    answer->value = EncodableValue(state);
    Post(window, answer);
  }).detach();
}

}  // namespace

void Register(flutter::BinaryMessenger* messenger, HWND window) {
  g_window = window;
  g_channel = std::make_unique<flutter::MethodChannel<EncodableValue>>(
      messenger, "vesopa/store_update",
      &flutter::StandardMethodCodec::GetInstance());
  g_channel->SetMethodCallHandler(
      [window](const flutter::MethodCall<EncodableValue>& call,
               std::unique_ptr<flutter::MethodResult<EncodableValue>> result) {
        auto* answer = new Answer{std::move(result), EncodableValue()};
        if (call.method_name() == "check") {
          Check(window, answer);
        } else if (call.method_name() == "install") {
          Install(window, answer);
        } else {
          answer->result->NotImplemented();
          delete answer;
        }
      });
}

void Unregister() {
  g_channel = nullptr;
  g_window = nullptr;
}

std::optional<LRESULT> HandleMessage(UINT message, LPARAM lparam) {
  if (message != kStoreAnswer) return std::nullopt;
  std::unique_ptr<Answer> answer(reinterpret_cast<Answer*>(lparam));
  if (answer->value.IsNull()) {
    answer->result->Success();
  } else {
    answer->result->Success(answer->value);
  }
  return 0;
}

}  // namespace store_update
