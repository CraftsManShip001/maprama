// Conformance test runner.
//   maprama_core_tests --fixtures <dir> [--emit <events.jsonl>] [--filter <substring>]
#include <cstring>
#include <fstream>
#include <stdexcept>

#include "harness.hpp"

namespace maprama::test {

std::string readFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open " + path);
  std::ostringstream os;
  os << in.rdbuf();
  return os.str();
}

json::Value loadFixture(const Context& ctx, const std::string& file) {
  const std::string path = ctx.fixturesDir + "/" + file;
  json::ParseResult parsed = json::parse(readFile(path));
  if (!parsed.ok) throw std::runtime_error("invalid fixture JSON in " + path + ": " + parsed.error);
  return std::move(parsed.value);
}

}  // namespace maprama::test

int main(int argc, char** argv) {
  maprama::test::Context ctx;
  ctx.fixturesDir = "cpp/tests/fixtures";
  std::string filter;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--fixtures" && i + 1 < argc) {
      ctx.fixturesDir = argv[++i];
    } else if (arg == "--emit" && i + 1 < argc) {
      ctx.emitPath = argv[++i];
    } else if (arg == "--filter" && i + 1 < argc) {
      filter = argv[++i];
    } else {
      std::cerr << "usage: maprama_core_tests --fixtures <dir> [--emit <file>] [--filter <substring>]\n";
      return 2;
    }
  }

  // Suites append the envelopes they emitted; start from an empty file (suite order is link order).
  if (!ctx.emitPath.empty()) std::ofstream(ctx.emitPath, std::ios::trunc).flush();

  int suites = 0;
  int failedSuites = 0;
  for (const auto& [name, fn] : maprama::test::registry()) {
    if (!filter.empty() && std::strstr(name, filter.c_str()) == nullptr) continue;
    ++suites;
    const long checksBefore = ctx.checks;
    const long failuresBefore = ctx.failures;
    ctx.reportedInSuite = 0;
    try {
      fn(ctx);
    } catch (const std::exception& e) {
      ctx.check(false, std::string("uncaught exception: ") + e.what());
    }
    const long checks = ctx.checks - checksBefore;
    const long failures = ctx.failures - failuresBefore;
    if (failures > 0) ++failedSuites;
    std::cout << (failures == 0 ? "  PASS " : "  FAIL ") << name << " (" << checks << " checks";
    if (failures > 0) std::cout << ", " << failures << " failed";
    std::cout << ")\n";
  }

  std::cout << "maprama_core_tests: " << suites << " suites, " << ctx.checks << " checks, " << ctx.failures
            << " failures\n";
  if (suites == 0) {
    std::cerr << "maprama_core_tests: no suites matched\n";
    return 1;
  }
  return (ctx.failures == 0 && failedSuites == 0) ? 0 : 1;
}
