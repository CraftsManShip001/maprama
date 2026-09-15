# libmaprama_engine.so: the shared C++ core (../cpp/src) + JNI glue for the Kotlin wrapper + the M2c custom
# building layer (GL ES 3 CustomLayerHost for MapLibre's `android-sdk-opengl`; its interface header is vendored
# from the pinned MapLibre Native tag under src/main/cpp/vendor/maplibre, BSD-2-Clause).
cmake_minimum_required(VERSION 3.13)
project(maprama_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(MAPRAMA_CORE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../cpp)
file(GLOB MAPRAMA_CORE_SOURCES CONFIGURE_DEPENDS ${MAPRAMA_CORE_DIR}/src/*.cpp)

add_library(maprama_engine SHARED ${MAPRAMA_CORE_SOURCES} src/main/cpp/maprama_jni.cpp src/main/cpp/maprama_building_layer.cpp)
target_include_directories(maprama_engine PRIVATE ${MAPRAMA_CORE_DIR}/include ${MAPRAMA_CORE_DIR}/src
                           src/main/cpp/vendor/maplibre/include)
target_compile_options(maprama_engine PRIVATE -fexceptions -frtti -Wall -O2)
target_link_options(maprama_engine PRIVATE "-Wl,-z,max-page-size=16384")

find_library(log-lib log)
find_library(gles-lib GLESv3)
target_link_libraries(maprama_engine ${log-lib} ${gles-lib})
