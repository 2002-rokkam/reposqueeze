cmake_minimum_required(VERSION 3.20)
project(widget VERSION 1.2.0 LANGUAGES CXX)

option(WIDGET_BUILD_TESTS "Build unit tests" ON)
set(CMAKE_CXX_STANDARD 20)

# Core library
add_library(widget_core
  src/engine.cpp
  src/parser.cpp
  src/render.cpp
)
target_include_directories(widget_core PUBLIC include)
target_link_libraries(widget_core
  PUBLIC fmt::fmt
  PRIVATE Threads::Threads
)

function(widget_add_tool name)
  add_executable(${name} tools/${name}.cpp)
  target_link_libraries(${name} PRIVATE widget_core)
  install(TARGETS ${name} RUNTIME DESTINATION bin)
endfunction()

if(WIDGET_BUILD_TESTS)
  enable_testing()
  find_package(GTest REQUIRED)
  add_executable(widget_tests tests/engine_test.cpp)
  target_link_libraries(widget_tests PRIVATE widget_core GTest::gtest_main)
  add_test(NAME widget_tests COMMAND widget_tests)
endif()

widget_add_tool(widgetc)
message(STATUS "widget configured") # trailing comment with ( paren
