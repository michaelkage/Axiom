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
set(GGML_VULKAN ON CACHE BOOL "" FORCE)
set(GGML_CPU_KLEIDIAI ON CACHE BOOL "" FORCE)

FetchContent_Declare(
  llama_cpp
  GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
  GIT_TAG b12248
  GIT_SHALLOW TRUE
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_MakeAvailable(llama_cpp)

# llama.cpp's Vulkan backend includes the Vulkan-Hpp C++ bindings. Android's
# NDK ships the C Vulkan headers and loader, but not vulkan.hpp. Use the host
# Vulkan-Headers package for compile-time headers while linking against the
# Android NDK Vulkan loader selected by FindVulkan.
if(ANDROID AND TARGET ggml-vulkan)
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
