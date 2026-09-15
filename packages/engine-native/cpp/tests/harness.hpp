// Minimal self-registering test harness (no third-party test framework).
#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "diorama/json.hpp"

namespace diorama::test {

struct Context {
  std::string fixturesDir;
  std::string emitPath;
  long checks = 0;
  long failures = 0;
  int reportedInSuite = 0;

  bool check(bool condition, const std::string& what) {
    ++checks;
    if (!condition) {
      ++failures;
      if (++reportedInSuite <= 25) std::cerr << "    FAIL: " << what << "\n";
    }
    return condition;
  }

  bool near(double actual, double expected, double tolerance, const std::string& what) {
    const bool ok = std::fabs(actual - expected) <= tolerance;
    if (!ok) {
      std::ostringstream os;
      os.precision(17);
      os << what << ": expected " << expected << ", got " << actual << " (tolerance " << tolerance << ")";
      return check(false, os.str());
    }
    return check(true, what);
  }
};

using TestFn = void (*)(Context&);

inline std::vector<std::pair<const char*, TestFn>>& registry() {
  static std::vector<std::pair<const char*, TestFn>> tests;
  return tests;
}

struct Register {
  Register(const char* name, TestFn fn) { registry().emplace_back(name, fn); }
};

#define DIORAMA_TEST(name)                                           \
  static void name(::diorama::test::Context& ctx);                   \
  static ::diorama::test::Register register_##name(#name, name);     \
  static void name(::diorama::test::Context& ctx)

std::string readFile(const std::string& path);
/// Loads and parses `<fixturesDir>/<file>`; throws std::runtime_error when missing or invalid.
json::Value loadFixture(const Context& ctx, const std::string& file);

inline std::string truncate(const std::string& s, std::size_t max = 160) {
  return s.size() <= max ? s : s.substr(0, max) + "...";
}

}  // namespace diorama::test
