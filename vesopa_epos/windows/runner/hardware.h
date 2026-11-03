#ifndef RUNNER_HARDWARE_H_
#define RUNNER_HARDWARE_H_

#include <flutter/binary_messenger.h>
#include <windows.h>

#include <optional>

// Settings > Network and hardware: this PC's network adapters, Wi-Fi, mobile
// hotspot and the devices on it, Bluetooth, and USB and serial devices, on the
// "vesopa/hardware" channel. The changes that need an administrator go to the
// network helper service (windows/nethelper).
namespace hardware {

void Register(flutter::BinaryMessenger* messenger, HWND window);
void Unregister();

// The window's message loop hands every message here first; answers from the
// worker threads come back this way.
std::optional<LRESULT> HandleMessage(UINT message, LPARAM lparam);

}  // namespace hardware

#endif  // RUNNER_HARDWARE_H_
