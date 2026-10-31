include_guard(GLOBAL)

#[[ Collect every source file below a directory.
    Usage: collect_sources(OUT dir) ]]
macro(collect_sources out dir)
  file(GLOB_RECURSE ${out} CONFIGURE_DEPENDS "${dir}/*.cpp" "${dir}/*.hpp")
endmacro()

function(enable_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endfunction()

set(WIDGET_MESSAGE [=[bracket "argument" with ) paren]=])
