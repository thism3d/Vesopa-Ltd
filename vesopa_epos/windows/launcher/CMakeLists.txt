cmake_minimum_required(VERSION 3.14)
project(vesopa_start LANGUAGES CXX)

# vesopa_start.exe (launcher.cpp): the till's icon. Checks every shipped file is
# there and repairs the till from its own kept installer when one is missing.
#
# The C runtime is built in (/MT rather than /MD), here and only here, so this
# program needs no DLL of any kind: it is the one thing that must start when
# files are missing.
foreach(flags CMAKE_CXX_FLAGS_RELEASE CMAKE_CXX_FLAGS_PROFILE CMAKE_CXX_FLAGS_DEBUG)
  string(REPLACE "/MDd" "/MTd" ${flags} "${${flags}}")
  string(REPLACE "/MD" "/MT" ${flags} "${${flags}}")
endforeach()

add_executable(vesopa_start WIN32 "launcher.cpp")
apply_standard_settings(vesopa_start)
target_compile_definitions(vesopa_start PRIVATE "NOMINMAX" "UNICODE" "_UNICODE")
target_link_libraries(vesopa_start PRIVATE "shell32.lib" "ole32.lib")
install(TARGETS vesopa_start RUNTIME DESTINATION "${CMAKE_INSTALL_PREFIX}"
  COMPONENT Runtime)
