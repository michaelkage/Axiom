cmake_minimum_required(VERSION 3.22.1)
project(axiom_runtime LANGUAGES C CXX)

include(FetchContent)

# Vulkan shader generation runs on the host while ggml-vulkan itself targets Android.
# The Android toolchain restricts package discovery to its sysroot, so point the
# SPIR-V headers package at the host config installed by the CI dependency step.
if(ANDROID AND DEFINED ENV{SPIRV_HEADERS_CMAKE_DIR})
  set(SPIRV-Headers_DIR "$ENV{SPIRV_HEADERS_CMAKE_DIR}" CACHE PATH "Host SPIR-V headers package" FORCE)
endif()
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
# Keep the Vulkan backend enabled by default. CI may select the CPU backend
# when host Vulkan SDK packages are unreachable; Android's CPU backend remains
# fully supported and does not require host Vulkan headers or shader tools.
set(AXIOM_ENABLE_VULKAN ON)
if(DEFINED ENV{AXIOM_ENABLE_VULKAN} AND "$ENV{AXIOM_ENABLE_VULKAN}" STREQUAL "0")
  set(AXIOM_ENABLE_VULKAN OFF)
endif()
set(GGML_VULKAN ${AXIOM_ENABLE_VULKAN} CACHE BOOL "" FORCE)
set(GGML_CPU_KLEIDIAI ON CACHE BOOL "" FORCE)

FetchContent_Declare(
  llama_cpp
  GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
  GIT_TAG b12248
  GIT_SHALLOW TRUE
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_MakeAvailable(llama_cpp)

# Android's Vulkan loader exports Vulkan 1.0 entry points from libvulkan.so;
# Vulkan 1.1+ entry points must be resolved through vkGetInstanceProcAddr.
# llama.cpp b12248 uses two direct C calls for Features2, which fail to link
# against the Android NDK loader. Route those calls through Vulkan-Hpp's
# already-configured dynamic dispatcher instead of weakening Vulkan support.
set(AXIOM_GGML_VULKAN_SOURCE "${llama_cpp_SOURCE_DIR}/ggml/src/ggml-vulkan/ggml-vulkan.cpp")
if(ANDROID AND AXIOM_ENABLE_VULKAN AND EXISTS "${AXIOM_GGML_VULKAN_SOURCE}")
  file(READ "${AXIOM_GGML_VULKAN_SOURCE}" AXIOM_GGML_VULKAN_CONTENT)
  set(AXIOM_VK_FEATURES2_OLD "vkGetPhysicalDeviceFeatures2(device->physical_device, &device_features2);")
  set(AXIOM_VK_FEATURES2_NEW "(void)vk::PhysicalDevice(device->physical_device).getFeatures2(reinterpret_cast<vk::PhysicalDeviceFeatures2 *>(&device_features2));")
  string(FIND "${AXIOM_GGML_VULKAN_CONTENT}" "${AXIOM_VK_FEATURES2_OLD}" AXIOM_VK_FEATURES2_OLD_POS)
  if(NOT AXIOM_VK_FEATURES2_OLD_POS EQUAL -1)
    string(REPLACE "${AXIOM_VK_FEATURES2_OLD}" "${AXIOM_VK_FEATURES2_NEW}" AXIOM_GGML_VULKAN_CONTENT "${AXIOM_GGML_VULKAN_CONTENT}")
  else()
    string(FIND "${AXIOM_GGML_VULKAN_CONTENT}" "${AXIOM_VK_FEATURES2_NEW}" AXIOM_VK_FEATURES2_NEW_POS)
    if(AXIOM_VK_FEATURES2_NEW_POS EQUAL -1)
      message(FATAL_ERROR "Pinned llama.cpp Vulkan source changed: cannot apply Android Features2 dispatch fix")
    endif()
  endif()

  set(AXIOM_VK_FEATURES2_OLD "vkGetPhysicalDeviceFeatures2(physical_device, &device_features2);")
  set(AXIOM_VK_FEATURES2_NEW "(void)vk::PhysicalDevice(physical_device).getFeatures2(reinterpret_cast<vk::PhysicalDeviceFeatures2 *>(&device_features2));")
  string(FIND "${AXIOM_GGML_VULKAN_CONTENT}" "${AXIOM_VK_FEATURES2_OLD}" AXIOM_VK_FEATURES2_OLD_POS)
  if(NOT AXIOM_VK_FEATURES2_OLD_POS EQUAL -1)
    string(REPLACE "${AXIOM_VK_FEATURES2_OLD}" "${AXIOM_VK_FEATURES2_NEW}" AXIOM_GGML_VULKAN_CONTENT "${AXIOM_GGML_VULKAN_CONTENT}")
  else()
    string(FIND "${AXIOM_GGML_VULKAN_CONTENT}" "${AXIOM_VK_FEATURES2_NEW}" AXIOM_VK_FEATURES2_NEW_POS)
    if(AXIOM_VK_FEATURES2_NEW_POS EQUAL -1)
      message(FATAL_ERROR "Pinned llama.cpp Vulkan source changed: cannot apply Android Features2 dispatch fix")
    endif()
  endif()
  # b12248 also has a third Features2 call using a vk::PhysicalDevice
  # parameter. Patch it through Vulkan-Hpp's dynamic dispatcher as well.
  set(AXIOM_VK_FEATURES2_OLD "vkGetPhysicalDeviceFeatures2(vkdev, &device_features2);")
  set(AXIOM_VK_FEATURES2_NEW "(void)vkdev.getFeatures2(reinterpret_cast<vk::PhysicalDeviceFeatures2 *>(&device_features2));")
  string(FIND "${AXIOM_GGML_VULKAN_CONTENT}" "${AXIOM_VK_FEATURES2_OLD}" AXIOM_VK_FEATURES2_OLD_POS)
  if(NOT AXIOM_VK_FEATURES2_OLD_POS EQUAL -1)
    string(REPLACE "${AXIOM_VK_FEATURES2_OLD}" "${AXIOM_VK_FEATURES2_NEW}" AXIOM_GGML_VULKAN_CONTENT "${AXIOM_GGML_VULKAN_CONTENT}")
  else()
    string(FIND "${AXIOM_GGML_VULKAN_CONTENT}" "${AXIOM_VK_FEATURES2_NEW}" AXIOM_VK_FEATURES2_NEW_POS)
    if(AXIOM_VK_FEATURES2_NEW_POS EQUAL -1)
      message(FATAL_ERROR "Pinned llama.cpp Vulkan source changed: cannot apply Android vkdev Features2 dispatch fix")
    endif()
  endif()

  file(WRITE "${AXIOM_GGML_VULKAN_SOURCE}" "${AXIOM_GGML_VULKAN_CONTENT}")
endif()

# llama.cpp's Vulkan backend includes the Vulkan-Hpp C++ bindings. Android's
# NDK ships the C Vulkan headers and loader, but not vulkan.hpp. Use the host
# Vulkan-Headers package for compile-time headers while linking against the
# Android NDK Vulkan loader selected by FindVulkan.
if(ANDROID AND AXIOM_ENABLE_VULKAN AND TARGET ggml-vulkan)
  find_path(AXIOM_VULKAN_HPP_INCLUDE_DIR
    NAMES vulkan/vulkan.hpp
    PATHS /usr/include /usr/local/include
    NO_CMAKE_FIND_ROOT_PATH
    REQUIRED
  )
  # CMake/Clang may discard /usr/include as an implicit system path when
  # cross-compiling with the Android sysroot. Stage Vulkan headers under the
  # build tree so the include directory is explicit in the NDK compile command.
  set(AXIOM_VULKAN_STAGED_INCLUDE_DIR "${CMAKE_BINARY_DIR}/axiom-vulkan-headers")
  file(COPY "${AXIOM_VULKAN_HPP_INCLUDE_DIR}/vulkan"
    DESTINATION "${AXIOM_VULKAN_STAGED_INCLUDE_DIR}"
  )
  # The backend also includes SPIRV-Headers directly (spirv/unified1/spirv.hpp).
  # Stage that tree beside Vulkan-Hpp so the Android cross-compiler can resolve
  # both host-provided header families through one explicit include directory.
  find_path(AXIOM_SPIRV_INCLUDE_DIR
    NAMES spirv/unified1/spirv.hpp
    PATHS /usr/include /usr/local/include
    NO_CMAKE_FIND_ROOT_PATH
    REQUIRED
  )
  file(COPY "${AXIOM_SPIRV_INCLUDE_DIR}/spirv"
    DESTINATION "${AXIOM_VULKAN_STAGED_INCLUDE_DIR}"
  )
  target_include_directories(ggml-vulkan SYSTEM BEFORE PRIVATE
    "${AXIOM_VULKAN_STAGED_INCLUDE_DIR}"
  )
endif()

add_library(axiompty SHARED axiompty.cpp axiom_llama.cpp)
target_compile_features(axiompty PRIVATE cxx_std_17)
target_include_directories(axiompty PRIVATE ${llama_cpp_SOURCE_DIR}/include)
target_link_libraries(axiompty PRIVATE llama ggml android log dl)
