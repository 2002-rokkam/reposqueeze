find_path(FOO_INCLUDE_DIR foo/foo.h
  PATHS /usr/include /usr/local/include
)
find_library(FOO_LIBRARY NAMES foo)

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(Foo DEFAULT_MSG FOO_LIBRARY FOO_INCLUDE_DIR)

if(Foo_FOUND AND NOT TARGET Foo::Foo)
  add_library(Foo::Foo UNKNOWN IMPORTED)
  set_target_properties(Foo::Foo PROPERTIES
    IMPORTED_LOCATION "${FOO_LIBRARY}"
    INTERFACE_INCLUDE_DIRECTORIES "${FOO_INCLUDE_DIR}")
endif()
