#ifndef RUNNER_STORE_UPDATE_H_
#define RUNNER_STORE_UPDATE_H_

#include <flutter/binary_messenger.h>
#include <windows.h>

#include <optional>

// Updating a Microsoft Store copy in place (2026-10-08), the same way a copy
// from our own installer updates: lib/data/app_update.dart asks over the
// "vesopa/store_update" channel.
//
//   check    -> {available: bool, version: "1.15.1.0"} from the Store, or
//               null when this copy is not a Store package.
//   install  -> "completed", "none", "canceled" or "failed". Windows closes
//               the app to replace it and, as the app registers for restart
//               first, opens it again.
//
// Both go through Windows.Services.Store, the Store's own update service, so
// the update still comes from the Store; nothing else is downloaded.
namespace store_update {

void Register(flutter::BinaryMessenger* messenger, HWND window);
void Unregister();
std::optional<LRESULT> HandleMessage(UINT message, LPARAM lparam);

}  // namespace store_update

#endif  // RUNNER_STORE_UPDATE_H_
