// Order matters: winsock before windows.h (which hardware.h brings), then the
// IP helper.
#include <winsock2.h>
#include <ws2tcpip.h>

#include "hardware.h"

#include <iphlpapi.h>
#include <wlanapi.h>
#include <setupapi.h>
#include <cfgmgr32.h>

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>

#include <cstdint>
#include <cwctype>
#include <memory>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <winrt/Windows.Devices.Radios.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Networking.h>
#include <winrt/Windows.Networking.Connectivity.h>
#include <winrt/Windows.Networking.NetworkOperators.h>

namespace hardware {
namespace {

using flutter::EncodableList;
using flutter::EncodableMap;
using flutter::EncodableValue;
namespace radios = winrt::Windows::Devices::Radios;
namespace conn = winrt::Windows::Networking::Connectivity;
namespace ops = winrt::Windows::Networking::NetworkOperators;

constexpr UINT kHardwareAnswer = WM_APP + 0x54;
constexpr wchar_t kPipe[] = L"\\\\.\\pipe\\vesopa-nethelper";

std::unique_ptr<flutter::MethodChannel<EncodableValue>> g_channel;

struct Answer {
  std::unique_ptr<flutter::MethodResult<EncodableValue>> result;
  EncodableValue value;
};

std::string Narrow(const wchar_t* w) {
  if (!w || !*w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n > 0 ? n - 1 : 0), '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::string Narrow(const winrt::hstring& h) { return Narrow(h.c_str()); }

std::wstring Widen(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string Mac(const BYTE* bytes, ULONG length) {
  static const char kHex[] = "0123456789ABCDEF";
  std::string out;
  for (ULONG i = 0; i < length; i++) {
    if (i) out += ':';
    out += kHex[bytes[i] >> 4];
    out += kHex[bytes[i] & 15];
  }
  return out;
}

std::string Address(const SOCKADDR* addr) {
  char buf[64] = {0};
  if (addr->sa_family == AF_INET) {
    inet_ntop(AF_INET, &reinterpret_cast<const sockaddr_in*>(addr)->sin_addr, buf, sizeof(buf));
  } else if (addr->sa_family == AF_INET6) {
    inet_ntop(AF_INET6, &reinterpret_cast<const sockaddr_in6*>(addr)->sin6_addr, buf, sizeof(buf));
  }
  return buf;
}

bool Contains(const std::wstring& haystack, const wchar_t* needle) {
  std::wstring h = haystack, n = needle;
  for (auto& c : h) c = static_cast<wchar_t>(towlower(c));
  for (auto& c : n) c = static_cast<wchar_t>(towlower(c));
  return h.find(n) != std::wstring::npos;
}

// Every adapter a person would recognise: wired, Wi-Fi, Bluetooth and the
// hotspot's own; not loopback or the tunnels Windows keeps for itself.
EncodableList Adapters() {
  EncodableList list;
  ULONG size = 32 * 1024;
  std::vector<BYTE> buf(size);
  const ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                      GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_INCLUDE_GATEWAYS;
  auto* first = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buf.data());
  ULONG rc = GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, first, &size);
  if (rc == ERROR_BUFFER_OVERFLOW) {
    buf.resize(size);
    first = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buf.data());
    rc = GetAdaptersAddresses(AF_UNSPEC, flags, nullptr, first, &size);
  }
  if (rc != NO_ERROR) return list;
  for (auto* a = first; a; a = a->Next) {
    if (a->IfType == IF_TYPE_SOFTWARE_LOOPBACK || a->IfType == IF_TYPE_TUNNEL) continue;
    const std::wstring desc = a->Description ? a->Description : L"";
    std::string kind = a->IfType == IF_TYPE_IEEE80211 ? "wifi" : "ethernet";
    if (Contains(desc, L"bluetooth")) kind = "bluetooth";
    if (Contains(desc, L"wi-fi direct") || Contains(desc, L"hosted network")) kind = "hotspot";
    if (Contains(desc, L"hyper-v") || Contains(desc, L"virtualbox") || Contains(desc, L"vmware") ||
        Contains(desc, L"wan miniport") || Contains(desc, L"kernel debug")) {
      kind = "virtual";
    }
    EncodableList ips;
    for (auto* u = a->FirstUnicastAddress; u; u = u->Next) {
      if (u->Address.lpSockaddr->sa_family != AF_INET) continue;
      ips.push_back(EncodableValue(Address(u->Address.lpSockaddr) + "/" +
                                   std::to_string(u->OnLinkPrefixLength)));
    }
    std::string gateway;
    for (auto* g = a->FirstGatewayAddress; g; g = g->Next) {
      if (g->Address.lpSockaddr->sa_family == AF_INET) {
        gateway = Address(g->Address.lpSockaddr);
        break;
      }
    }
    EncodableMap m;
    m[EncodableValue("index")] = EncodableValue(static_cast<int32_t>(a->IfIndex));
    m[EncodableValue("name")] = EncodableValue(Narrow(a->FriendlyName));
    m[EncodableValue("description")] = EncodableValue(Narrow(desc.c_str()));
    m[EncodableValue("kind")] = EncodableValue(kind);
    m[EncodableValue("up")] = EncodableValue(a->OperStatus == IfOperStatusUp);
    m[EncodableValue("mac")] = EncodableValue(Mac(a->PhysicalAddress, a->PhysicalAddressLength));
    m[EncodableValue("speed_mbps")] = EncodableValue(static_cast<int64_t>(
        a->TransmitLinkSpeed == ULONG64(-1) ? 0 : a->TransmitLinkSpeed / 1000000));
    m[EncodableValue("ips")] = EncodableValue(ips);
    m[EncodableValue("gateway")] = EncodableValue(gateway);
    list.push_back(EncodableValue(m));
  }
  return list;
}

// The Wi-Fi network this PC is on and how strong it is. Windows 11 may keep
// the network's name back unless desktop apps may see the location
// (Settings > Privacy > Location); the signal still comes through.
EncodableValue Wifi() {
  HANDLE client = nullptr;
  DWORD version = 0;
  if (WlanOpenHandle(2, nullptr, &version, &client) != ERROR_SUCCESS) return EncodableValue();
  EncodableValue out;
  WLAN_INTERFACE_INFO_LIST* list = nullptr;
  if (WlanEnumInterfaces(client, nullptr, &list) == ERROR_SUCCESS) {
    for (DWORD i = 0; i < list->dwNumberOfItems; i++) {
      const auto& info = list->InterfaceInfo[i];
      if (info.isState != wlan_interface_state_connected) continue;
      DWORD bytes = 0;
      WLAN_CONNECTION_ATTRIBUTES* attrs = nullptr;
      if (WlanQueryInterface(client, &info.InterfaceGuid, wlan_intf_opcode_current_connection,
                             nullptr, &bytes, reinterpret_cast<void**>(&attrs),
                             nullptr) == ERROR_SUCCESS) {
        const auto& ssid = attrs->wlanAssociationAttributes.dot11Ssid;
        EncodableMap m;
        m[EncodableValue("ssid")] = EncodableValue(
            std::string(reinterpret_cast<const char*>(ssid.ucSSID), ssid.uSSIDLength));
        m[EncodableValue("profile")] = EncodableValue(Narrow(attrs->strProfileName));
        m[EncodableValue("signal")] =
            EncodableValue(static_cast<int32_t>(attrs->wlanAssociationAttributes.wlanSignalQuality));
        m[EncodableValue("rx_mbps")] =
            EncodableValue(static_cast<int32_t>(attrs->wlanAssociationAttributes.ulRxRate / 1000));
        m[EncodableValue("adapter")] = EncodableValue(Narrow(info.strInterfaceDescription));
        out = EncodableValue(m);
        WlanFreeMemory(attrs);
        break;
      }
    }
    WlanFreeMemory(list);
  }
  WlanCloseHandle(client, nullptr);
  return out;
}

std::string RegistryText(HDEVINFO set, SP_DEVINFO_DATA* data, DWORD property) {
  wchar_t buf[512] = {0};
  if (!SetupDiGetDeviceRegistryPropertyW(set, data, property, nullptr,
                                         reinterpret_cast<PBYTE>(buf), sizeof(buf) - sizeof(wchar_t),
                                         nullptr)) {
    return {};
  }
  return Narrow(buf);
}

// USB and Bluetooth devices, serial ports (card machines, scales, cash
// drawers) and the Bluetooth radio itself; not the hubs and controllers.
EncodableList Devices() {
  EncodableList list;
  HDEVINFO set = SetupDiGetClassDevsW(nullptr, nullptr, nullptr, DIGCF_PRESENT | DIGCF_ALLCLASSES);
  if (set == INVALID_HANDLE_VALUE) return list;
  SP_DEVINFO_DATA data{sizeof(data)};
  for (DWORD i = 0; SetupDiEnumDeviceInfo(set, i, &data); i++) {
    wchar_t idw[400] = {0};
    if (!SetupDiGetDeviceInstanceIdW(set, &data, idw, 399, nullptr)) continue;
    const std::string id = Narrow(idw);
    const std::string enumerator = RegistryText(set, &data, SPDRP_ENUMERATOR_NAME);
    const std::string cls = RegistryText(set, &data, SPDRP_CLASS);
    std::string name = RegistryText(set, &data, SPDRP_FRIENDLYNAME);
    if (name.empty()) name = RegistryText(set, &data, SPDRP_DEVICEDESC);

    std::string kind;
    const std::wstring upper(idw);
    if (cls == "Bluetooth" && (enumerator == "USB" || enumerator == "PCI")) {
      kind = "bluetooth-radio";
    } else if ((enumerator == "BTHENUM" && Contains(upper, L"bthenum\\dev_")) ||
               (enumerator == "BTHLE" && Contains(upper, L"bthle\\dev_"))) {
      kind = "bluetooth";
    } else if (cls == "Ports") {
      kind = "serial";
    } else if (enumerator == "USBPRINT") {
      kind = "usb-printer";
    } else if (enumerator == "USB" && cls != "USB" && cls != "Bluetooth" && cls != "Net") {
      kind = "usb";
    }
    if (kind.empty() || name.empty()) continue;

    ULONG status = 0, problem = 0;
    const bool ok = CM_Get_DevNode_Status(&status, &problem, data.DevInst, 0) == CR_SUCCESS;
    EncodableMap m;
    m[EncodableValue("id")] = EncodableValue(id);
    m[EncodableValue("name")] = EncodableValue(name);
    m[EncodableValue("kind")] = EncodableValue(kind);
    m[EncodableValue("class")] = EncodableValue(cls);
    m[EncodableValue("working")] = EncodableValue(ok && problem == 0 && (status & DN_STARTED));
    m[EncodableValue("problem")] = EncodableValue(static_cast<int32_t>(ok ? problem : 0));
    list.push_back(EncodableValue(m));
  }
  SetupDiDestroyDeviceInfoList(set);
  return list;
}

EncodableList Radios() {
  EncodableList list;
  try {
    radios::Radio::RequestAccessAsync().get();
    for (auto const& r : radios::Radio::GetRadiosAsync().get()) {
      std::string kind;
      if (r.Kind() == radios::RadioKind::Bluetooth) kind = "bluetooth";
      else if (r.Kind() == radios::RadioKind::WiFi) kind = "wifi";
      else continue;
      EncodableMap m;
      m[EncodableValue("kind")] = EncodableValue(kind);
      m[EncodableValue("name")] = EncodableValue(Narrow(r.Name()));
      m[EncodableValue("on")] = EncodableValue(r.State() == radios::RadioState::On);
      list.push_back(EncodableValue(m));
    }
  } catch (...) {
  }
  return list;
}

// The profile the hotspot shares: the internet one, or with the internet down
// any connected network (Windows 11 can share a network with no internet, so
// Go phones stay on the local link).
conn::ConnectionProfile SharedProfile() {
  auto profile = conn::NetworkInformation::GetInternetConnectionProfile();
  if (profile) return profile;
  for (auto const& p : conn::NetworkInformation::GetConnectionProfiles()) {
    if (p.GetNetworkConnectivityLevel() != conn::NetworkConnectivityLevel::None) return p;
  }
  return nullptr;
}

std::string StateName(ops::TetheringOperationalState s) {
  switch (s) {
    case ops::TetheringOperationalState::On: return "on";
    case ops::TetheringOperationalState::Off: return "off";
    case ops::TetheringOperationalState::InTransition: return "changing";
    default: return "unknown";
  }
}

EncodableValue Hotspot() {
  EncodableMap m;
  try {
    const auto profile = SharedProfile();
    if (!profile) {
      m[EncodableValue("supported")] = EncodableValue(false);
      m[EncodableValue("why")] = EncodableValue("not connected to any network");
      return EncodableValue(m);
    }
    const auto capability = ops::NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(profile);
    if (capability != ops::TetheringCapability::Enabled) {
      m[EncodableValue("supported")] = EncodableValue(false);
      m[EncodableValue("why")] = EncodableValue(
          capability == ops::TetheringCapability::DisabledByHardwareLimitation
              ? "this PC's Wi-Fi cannot host a hotspot"
          : capability == ops::TetheringCapability::DisabledByGroupPolicy
              ? "turned off by the PC's group policy"
              : "Windows does not allow a hotspot on this network");
      return EncodableValue(m);
    }
    auto manager = ops::NetworkOperatorTetheringManager::CreateFromConnectionProfile(profile);
    const auto config = manager.GetCurrentAccessPointConfiguration();
    EncodableList clients;
    if (manager.TetheringOperationalState() == ops::TetheringOperationalState::On) {
      for (auto const& c : manager.GetTetheringClients()) {
        EncodableList names;
        for (auto const& h : c.HostNames()) names.push_back(EncodableValue(Narrow(h.DisplayName())));
        EncodableMap cm;
        cm[EncodableValue("mac")] = EncodableValue(Narrow(c.MacAddress()));
        cm[EncodableValue("names")] = EncodableValue(names);
        clients.push_back(EncodableValue(cm));
      }
    }
    m[EncodableValue("supported")] = EncodableValue(true);
    m[EncodableValue("state")] = EncodableValue(StateName(manager.TetheringOperationalState()));
    m[EncodableValue("ssid")] = EncodableValue(Narrow(config.Ssid()));
    m[EncodableValue("passphrase")] = EncodableValue(Narrow(config.Passphrase()));
    m[EncodableValue("shares")] = EncodableValue(Narrow(profile.ProfileName()));
    m[EncodableValue("max_clients")] = EncodableValue(static_cast<int32_t>(manager.MaxClientCount()));
    m[EncodableValue("clients")] = EncodableValue(clients);
  } catch (...) {
    // No Wi-Fi adapter to host it (a PC on a cable only, or a virtual machine).
    m[EncodableValue("supported")] = EncodableValue(false);
    m[EncodableValue("why")] = EncodableValue("this PC has no Wi-Fi that can host a hotspot");
  }
  return EncodableValue(m);
}

const EncodableValue* Arg(const EncodableMap& args, const char* key) {
  auto it = args.find(EncodableValue(key));
  return it == args.end() ? nullptr : &it->second;
}

std::string Text(const EncodableMap& args, const char* key) {
  const auto* v = Arg(args, key);
  return v && std::holds_alternative<std::string>(*v) ? std::get<std::string>(*v) : std::string();
}

bool Flag(const EncodableMap& args, const char* key) {
  const auto* v = Arg(args, key);
  return v && std::holds_alternative<bool>(*v) && std::get<bool>(*v);
}

std::string SetHotspot(const EncodableMap& args) {
  try {
    const auto profile = SharedProfile();
    if (!profile) return "not connected to any network";
    auto manager = ops::NetworkOperatorTetheringManager::CreateFromConnectionProfile(profile);
    const std::string ssid = Text(args, "ssid");
    const std::string pass = Text(args, "passphrase");
    if (!ssid.empty() || !pass.empty()) {
      auto config = manager.GetCurrentAccessPointConfiguration();
      if (!ssid.empty()) config.Ssid(winrt::hstring(Widen(ssid)));
      if (!pass.empty()) config.Passphrase(winrt::hstring(Widen(pass)));
      manager.ConfigureAccessPointAsync(config).get();
    }
    const auto result = Flag(args, "on") ? manager.StartTetheringAsync().get()
                                         : manager.StopTetheringAsync().get();
    if (result.Status() == ops::TetheringOperationStatus::Success) return "ok";
    const std::string extra = Narrow(result.AdditionalErrorMessage());
    return extra.empty() ? "Windows said no (" + std::to_string(static_cast<int>(result.Status())) + ")"
                         : extra;
  } catch (winrt::hresult_error const& e) {
    return Narrow(e.message());
  } catch (...) {
    return "Windows did not answer";
  }
}

std::string SetRadio(const EncodableMap& args) {
  try {
    const auto want = Text(args, "kind") == "wifi" ? radios::RadioKind::WiFi : radios::RadioKind::Bluetooth;
    if (radios::Radio::RequestAccessAsync().get() != radios::RadioAccessStatus::Allowed) {
      return "Windows does not let apps switch radios (Settings > Privacy > Radios)";
    }
    bool found = false;
    for (auto const& r : radios::Radio::GetRadiosAsync().get()) {
      if (r.Kind() != want) continue;
      found = true;
      const auto s = r.SetStateAsync(Flag(args, "on") ? radios::RadioState::On : radios::RadioState::Off).get();
      if (s != radios::RadioAccessStatus::Allowed) return "Windows did not allow it";
    }
    return found ? "ok" : "no such radio on this PC";
  } catch (...) {
    return "Windows did not answer";
  }
}

// One request to the helper service; "missing" when it is not installed.
std::string AskHelper(const std::string& request) {
  if (!WaitNamedPipeW(kPipe, 3000)) return "missing";
  HANDLE pipe = CreateFileW(kPipe, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return "missing";
  DWORD mode = PIPE_READMODE_MESSAGE;
  SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr);
  const std::string line = request + "\n";
  DWORD n = 0;
  std::string reply = "error no answer";
  if (WriteFile(pipe, line.data(), static_cast<DWORD>(line.size()), &n, nullptr)) {
    char buf[512];
    if (ReadFile(pipe, buf, sizeof(buf) - 1, &n, nullptr) && n > 0) {
      reply.assign(buf, n);
      while (!reply.empty() && (reply.back() == '\n' || reply.back() == '\r')) reply.pop_back();
    }
  }
  CloseHandle(pipe);
  return reply;
}

void Post(HWND window, Answer* answer) {
  if (!PostMessage(window, kHardwareAnswer, 0, reinterpret_cast<LPARAM>(answer))) delete answer;
}

void Work(HWND window, Answer* answer, std::string method, EncodableMap args) {
  std::thread([window, answer, method = std::move(method), args = std::move(args)]() {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (...) {
    }
    if (method == "snapshot") {
      EncodableMap m;
      m[EncodableValue("adapters")] = EncodableValue(Adapters());
      m[EncodableValue("wifi")] = Wifi();
      m[EncodableValue("radios")] = EncodableValue(Radios());
      m[EncodableValue("hotspot")] = Hotspot();
      m[EncodableValue("devices")] = EncodableValue(Devices());
      answer->value = EncodableValue(m);
    } else if (method == "hotspot") {
      answer->value = EncodableValue(SetHotspot(args));
    } else if (method == "radio") {
      answer->value = EncodableValue(SetRadio(args));
    } else if (method == "helper") {
      answer->value = EncodableValue(AskHelper(Text(args, "request")));
    }
    Post(window, answer);
  }).detach();
}

}  // namespace

void Register(flutter::BinaryMessenger* messenger, HWND window) {
  g_channel = std::make_unique<flutter::MethodChannel<EncodableValue>>(
      messenger, "vesopa/hardware", &flutter::StandardMethodCodec::GetInstance());
  g_channel->SetMethodCallHandler(
      [window](const flutter::MethodCall<EncodableValue>& call,
               std::unique_ptr<flutter::MethodResult<EncodableValue>> result) {
        const std::string& method = call.method_name();
        if (method != "snapshot" && method != "hotspot" && method != "radio" && method != "helper") {
          result->NotImplemented();
          return;
        }
        EncodableMap args;
        if (call.arguments() && std::holds_alternative<EncodableMap>(*call.arguments())) {
          args = std::get<EncodableMap>(*call.arguments());
        }
        Work(window, new Answer{std::move(result), EncodableValue()}, method, std::move(args));
      });
}

void Unregister() { g_channel = nullptr; }

std::optional<LRESULT> HandleMessage(UINT message, LPARAM lparam) {
  if (message != kHardwareAnswer) return std::nullopt;
  std::unique_ptr<Answer> answer(reinterpret_cast<Answer*>(lparam));
  if (answer->value.IsNull()) {
    answer->result->Success();
  } else {
    answer->result->Success(answer->value);
  }
  return 0;
}

}  // namespace hardware
