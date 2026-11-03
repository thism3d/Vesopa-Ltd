cmake_minimum_required(VERSION 3.14)
project(vesopa_nethelper LANGUAGES CXX)

# The network helper service (nethelper.cpp). A console program with no window,
# built beside the runner and installed next to it; the till copies it into
# Program Files when someone allows it once (Settings > Network and hardware).
add_executable(vesopa_nethelper "nethelper.cpp")
apply_standard_settings(vesopa_nethelper)
target_compile_definitions(vesopa_nethelper PRIVATE "NOMINMAX")
target_link_libraries(vesopa_nethelper PRIVATE "advapi32.lib" "shell32.lib" "ole32.lib")
set_target_properties(vesopa_nethelper PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE")
install(TARGETS vesopa_nethelper RUNTIME DESTINATION "${CMAKE_INSTALL_PREFIX}"
  COMPONENT Runtime)
