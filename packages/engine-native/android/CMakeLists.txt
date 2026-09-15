# libmaprama_engine.so: the shared C++ core (../cpp/src) + JNI glue for the Kotlin wrapper.
cmake_minimum_required(VERSION 3.13)
project(maprama_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(MAPRAMA_CORE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../cpp)
file(GLOB MAPRAMA_CORE_SOURCES CONFIGURE_DEPENDS ${MAPRAMA_CORE_DIR}/src/*.cpp)

add_library(maprama_engine SHARED ${MAPRAMA_CORE_SOURCES} src/main/cpp/maprama_jni.cpp)
target_include_directories(maprama_engine PRIVATE ${MAPRAMA_CORE_DIR}/include ${MAPRAMA_CORE_DIR}/src)
target_compile_options(maprama_engine PRIVATE -fexceptions -frtti -Wall -O2)
target_link_options(maprama_engine PRIVATE "-Wl,-z,max-page-size=16384")

find_library(log-lib log)
target_link_libraries(maprama_engine ${log-lib})
