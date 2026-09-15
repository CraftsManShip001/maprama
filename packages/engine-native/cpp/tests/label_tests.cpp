// M2b labels: engine-web's label rules against the labels.json fixture (exported from engine-web's own
// src/labels/index.ts), the MapLibre projection port, and the session behaviour (labelsIndex, setLabels /
// setLabelContent, card measurement, label frames) through the fake MapAdapter. Emitted envelopes go to
// --emit (verify-emitted-events).
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/LabelIcons.hpp"
#include "maprama/LabelSystem.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/WorldStore.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::json::Value;
using namespace maprama::test::maptest;
using maprama::test::Context;
namespace mp = maprama;
namespace cm = maprama::camera_math;

std::string str(const Value* v) { return v != nullptr && v->isString() ? v->asString() : std::string(); }
double num(const Value* v) { return v != nullptr && v->isNumber() ? v->asNumber() : std::nan(""); }
bool near(double a, double b, double tol = 1e-9) { return std::fabs(a - b) <= tol * std::max(1.0, std::fabs(b)); }

std::unique_ptr<mp::WorldStore> loadLabelWorld(const Value& worldCase) {
  auto store = mp::createWorldStore();
  const Value* inlineWorld = worldCase.find("world");
  mp::Result<mp::WorldLoadReport> r = inlineWorld != nullptr
                                          ? store->load(*inlineWorld)
                                          : store->loadJson(maprama::test::readFile(worldCase.find("inputPath")->asString()));
  if (!r.ok()) throw std::runtime_error("label fixture world failed to load: " + r.error);
  return store;
}

/// Numbers compared with a relative 1e-9 tolerance, everything else exactly; object members in any order.
bool nearJson(const Value& a, const Value& b) {
  if (a.type() != b.type()) return false;
  switch (a.type()) {
    case mp::json::Type::Number:
      return near(a.asNumber(), b.asNumber());
    case mp::json::Type::Array:
      if (a.items().size() != b.items().size()) return false;
      for (std::size_t i = 0; i < a.items().size(); ++i) {
        if (!nearJson(a.items()[i], b.items()[i])) return false;
      }
      return true;
    case mp::json::Type::Object:
      if (a.members().size() != b.members().size()) return false;
      for (const mp::json::Member& m : a.members()) {
        const Value* other = b.find(m.key);
        if (other == nullptr || !nearJson(m.value, *other)) return false;
      }
      return true;
    default:
      return mp::json::stringify(a) == mp::json::stringify(b);
  }
}

mp::LabelBox boxOf(const Value& v) {
  return mp::LabelBox{num(v.find("x")), num(v.find("y")), num(v.find("hw")), num(v.find("hh"))};
}

bool sameBox(const mp::LabelBox& a, const mp::LabelBox& b) {
  return near(a.x, b.x) && near(a.y, b.y) && near(a.hw, b.hw) && near(a.hh, b.hh);
}

mp::MapUiSpec uiSpecOf(const Value& v) {
  mp::MapUiSpec ui;
  if (const Value* z = v.find("zoomButtons")) ui.zoomButtons = z->asBool();
  if (const Value* s = v.find("scaleBar")) ui.scaleBar = s->asBool();
  if (const Value* a = v.find("attribution")) ui.attribution = a->asBool();
  return ui;
}

template <class E>
E enumOf(const Value* v) {
  return *mp::parseEnum<E>(v->asString());
}

}  // namespace

MAPRAMA_TEST(labels_index_matches_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  bool sawSeongsu = false;
  for (const Value& wc : fixture.find("worlds")->items()) {
    const std::string name = wc.find("name")->asString();
    const auto store = loadLabelWorld(wc);
    const std::vector<mp::LabelEntry> entries = mp::buildLabelEntries(*store->world(), *store->projection());
    const auto& expected = wc.find("entries")->items();
    ctx.check(entries.size() == expected.size(), "[" + name + "] " + std::to_string(expected.size()) + " label entries (got " +
                                                     std::to_string(entries.size()) + ")");
    if (entries.size() != expected.size()) continue;
    std::size_t mismatches = 0;
    std::set<std::string> ids;
    for (std::size_t i = 0; i < entries.size(); ++i) {
      const mp::LabelEntry& e = entries[i];
      const Value& x = expected[i];
      ids.insert(e.id);
      bool ok = e.id == str(x.find("id")) && std::string(mp::enumName(e.kind)) == str(x.find("kind")) && e.name == str(x.find("name")) &&
                e.pri == static_cast<int>(num(x.find("pri"))) && std::string(mp::enumName(e.icon)) == str(x.find("icon")) &&
                near(e.x, num(x.find("x"))) && near(e.z, num(x.find("z"))) && near(e.lngLat.lng, num(x.find("lngLat")->find("lng"))) &&
                near(e.lngLat.lat, num(x.find("lngLat")->find("lat"))) && e.water == (x.find("water") != nullptr && x.find("water")->asBool());
      ok = ok && (e.subtitle ? *e.subtitle == str(x.find("subtitle")) : x.find("subtitle") == nullptr);
      ok = ok && (e.category ? std::string(mp::enumName(*e.category)) == str(x.find("category")) : x.find("category") == nullptr);
      ok = ok && (e.roadClass ? std::string(mp::enumName(*e.roadClass)) == str(x.find("roadClass")) : x.find("roadClass") == nullptr);
      ok = ok && (e.tx ? near(*e.tx, num(x.find("tx"))) && near(*e.tz, num(x.find("tz"))) : x.find("tx") == nullptr);
      ok = ok && nearJson(mp::labelInfoValue(e), wc.find("infos")->items()[i]);
      if (!ok && ++mismatches <= 3) ctx.check(false, "[" + name + "] entry " + std::to_string(i) + " (" + e.id + ") matches engine-web");
    }
    ctx.check(mismatches == 0, "[" + name + "] every entry and LabelInfo matches engine-web (" + std::to_string(mismatches) + " differ)");
    ctx.check(ids.size() == entries.size(), "[" + name + "] label ids are unique");
    const Value index = mp::labelsIndexValue(entries);
    const mp::protocol::ValidationResult valid =
        mp::protocol::validateEngineEvent(Value::object({{"type", "labelsIndex"}, {"labels", index}}));
    ctx.check(valid.ok, "[" + name + "] labelsIndex validates: " + valid.error);
    if (name.find("seongsu") != std::string::npos) {
      sawSeongsu = true;
      std::size_t pois = 0, districts = 0;
      for (const mp::LabelEntry& e : entries) {
        pois += e.kind == mp::LabelKind::Poi ? 1 : 0;
        districts += e.kind == mp::LabelKind::District ? 1 : 0;
      }
      ctx.check(pois == 55 && districts == 0, "[" + name + "] 55 POI labels, no districts (engine-web labels.test.ts)");
      std::cout << "    seongsu: " << entries.size() << " labels (" << pois << " POIs, " << entries.size() - pois << " road anchors)\n";
    }
  }
  ctx.check(sawSeongsu, "labels.json includes the Seongsu sample");
}

MAPRAMA_TEST(label_content_and_rules_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  const auto store = loadLabelWorld(fixture.find("worlds")->items().at(0));
  const std::vector<mp::LabelEntry> entries = mp::buildLabelEntries(*store->world(), *store->projection());
  std::map<std::string, const mp::LabelEntry*> byId;
  for (const mp::LabelEntry& e : entries) byId[e.id] = &e;

  // Content modes.
  const auto host = mp::parseLabelContentEntries(*fixture.find("content")->find("entries"));
  std::size_t contentBad = 0, contentCases = 0;
  for (const Value& c : fixture.find("content")->find("cases")->items()) {
    ++contentCases;
    const mp::LabelEntry* e = byId.at(c.find("id")->asString());
    const mp::ResolvedLabelContent r = mp::resolveLabelContent(*e, enumOf<mp::LabelContentMode>(c.find("mode")), host);
    const Value& x = *c.find("resolved");
    const bool ok = r.title == str(x.find("title")) && r.subtitle == str(x.find("subtitle")) &&
                    std::string(mp::enumName(r.icon)) == str(x.find("icon")) && r.showIcon == x.find("showIcon")->asBool() &&
                    r.showSubtitle == x.find("showSubtitle")->asBool() && r.custom == x.find("custom")->asBool();
    if (!ok && ++contentBad <= 3) ctx.check(false, "content " + c.find("mode")->asString() + " " + e->id + " matches engine-web");
  }
  ctx.check(contentBad == 0, std::to_string(contentCases) + " content-mode cases match resolveLabelContent");

  // HUD exclusions.
  std::size_t hudBad = 0;
  for (const Value& c : fixture.find("hud")->items()) {
    const Value& insets = *c.find("insets");
    const auto boxes = mp::hudExclusions(num(c.find("vw")), num(c.find("vh")), uiSpecOf(*c.find("ui")),
                                         insets.find("top") ? num(insets.find("top")) : 0.0,
                                         insets.find("bottom") ? num(insets.find("bottom")) : 0.0);
    const auto& want = c.find("boxes")->items();
    bool ok = boxes.size() == want.size();
    for (std::size_t i = 0; ok && i < boxes.size(); ++i) ok = sameBox(boxes[i], boxOf(want[i]));
    hudBad += ok ? 0 : 1;
  }
  ctx.check(hudBad == 0, "hudExclusions matches engine-web (" + std::to_string(hudBad) + " differ)");

  // Greedy holo placement.
  std::size_t holoBad = 0, holoShown = 0;
  for (const Value& set : fixture.find("holo")->items()) {
    std::vector<mp::HoloCandidate> candidates;
    for (const Value& c : set.find("candidates")->items()) {
      mp::HoloCandidate h;
      h.id = c.find("id")->asString();
      h.kind = enumOf<mp::LabelKind>(c.find("kind"));
      h.pri = static_cast<int>(num(c.find("pri")));
      h.dT = num(c.find("dT"));
      h.eligible = c.find("eligible")->asBool();
      h.topX = num(c.find("top")->find("x"));
      h.topY = num(c.find("top")->find("y"));
      h.onScreen = c.find("onScreen")->asBool();
      h.w = num(c.find("w"));
      h.h = num(c.find("h"));
      candidates.push_back(h);
    }
    std::vector<mp::LabelBox> exclusions;
    for (const Value& b : set.find("exclusions")->items()) exclusions.push_back(boxOf(b));
    const auto shown = mp::placeHolo(candidates, exclusions, static_cast<int>(num(set.find("maxRoads"))));
    const auto& want = set.find("shown")->items();
    bool ok = shown.size() == want.size();
    for (std::size_t i = 0; ok && i < shown.size(); ++i) {
      ok = shown[i].first == want[i].find("id")->asString() && sameBox(shown[i].second, boxOf(*want[i].find("box")));
    }
    holoBad += ok ? 0 : 1;
    holoShown += shown.size();
  }
  ctx.check(holoBad == 0, "placeHolo matches engine-web on " + std::to_string(fixture.find("holo")->items().size()) + " sets (" +
                              std::to_string(holoShown) + " cards shown, " + std::to_string(holoBad) + " sets differ)");

  std::size_t bad = 0;
  for (const Value& c : fixture.find("eligible")->items()) {
    const auto& v = c.items();
    bad += mp::holoEligible(enumOf<mp::LabelKind>(&v[0]), v[1].asNumber(), v[2].asNumber()) == v[3].asBool() ? 0 : 1;
  }
  ctx.check(bad == 0, "holoEligible matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("visible")->items()) {
    const auto& v = c.items();
    bad += mp::domLabelVisible(enumOf<mp::LabelStyle>(&v[0]), enumOf<mp::LabelKind>(&v[1]), static_cast<int>(v[2].asNumber()),
                               v[3].asNumber(), v[4].asNumber()) == v[5].asBool()
               ? 0
               : 1;
  }
  ctx.check(bad == 0, "domLabelVisible matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("clamp")->items()) {
    const auto& v = c.items();
    const double out = v[3].isNull() ? mp::clampLabelX(v[0].asNumber(), v[1].asNumber(), v[2].asNumber())
                                     : mp::clampLabelX(v[0].asNumber(), v[1].asNumber(), v[2].asNumber(), v[3].asNumber());
    bad += near(out, v[4].asNumber()) ? 0 : 1;
  }
  ctx.check(bad == 0, "clampLabelX matches engine-web (6 dp default margin)");
  bad = 0;
  for (const Value& c : fixture.find("rotated")->items()) {
    const mp::LabelBox b = mp::rotatedBox(num(c.find("x")), num(c.find("y")), num(c.find("w")), num(c.find("h")), num(c.find("angle")));
    bad += sameBox(b, boxOf(*c.find("box"))) ? 0 : 1;
  }
  ctx.check(bad == 0, "rotatedBox matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("upright")->items()) bad += near(mp::uprightAngle(c.items()[0].asNumber()), c.items()[1].asNumber()) ? 0 : 1;
  ctx.check(bad == 0, "uprightAngle matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("tiles")->items()) {
    const auto& v = c.items();
    const mp::HoloIconTile tile = v[0].isNull() ? mp::HoloIconTile::Auto : enumOf<mp::HoloIconTile>(&v[0]);
    const char* names[] = {"white", "black", "color"};
    bad += names[static_cast<int>(mp::iconTileFor(tile, v[1].asBool()))] == v[2].asString() ? 0 : 1;
  }
  ctx.check(bad == 0, "iconTileFor matches engine-web");

  const Value& heights = *fixture.find("holoHeight");
  for (const mp::LabelKind k : {mp::LabelKind::Road, mp::LabelKind::District, mp::LabelKind::Poi}) {
    ctx.check(near(mp::holoHeight(k), num(heights.find(mp::enumName(k)))), "HOLO_HEIGHT." + std::string(mp::enumName(k)));
  }
  ctx.check(mp::kHoloMaxRoads == static_cast<int>(num(fixture.find("holoMaxRoads"))), "HOLO_MAX_ROADS");
  ctx.check(mp::kLabelEdgeMargin == num(fixture.find("edgeMargin")), "LABEL_EDGE_MARGIN");

  // Generated tables (scripts/generate-label-icons.mjs) agree with the fixture too.
  for (const mp::json::Member& m : fixture.find("poiSubtitles")->members()) {
    ctx.check(mp::poiSubtitle(*mp::parseEnum<mp::PoiCategory>(m.key)) == m.value.asString(), "POI_SUBTITLES." + m.key);
  }
  for (const mp::json::Member& m : fixture.find("kindSubtitles")->members()) {
    ctx.check(mp::kindSubtitle(*mp::parseEnum<mp::LabelIcon>(m.key)) == m.value.asString(), "KIND_SUBTITLES." + m.key);
  }
  for (const mp::json::Member& m : fixture.find("iconColors")->members()) {
    ctx.check(mp::cssHex(mp::iconColor(*mp::parseEnum<mp::LabelIcon>(m.key))) == m.value.asString(), "ICON_COLORS." + m.key);
  }
  for (std::size_t i = 0; i < mp::EnumNames<mp::LabelIcon>::values.size(); ++i) {
    const auto icon = static_cast<mp::LabelIcon>(i);
    const mp::IconDrawing& d = mp::holoIcon(icon);
    std::size_t coords = 0;
    for (std::size_t s = 0; s < d.shapeCount; ++s) {
      std::size_t want = 0;
      for (const char* op = d.shapes[s].ops; *op != '\0'; ++op) want += *op == 'C' ? 6 : *op == 'Z' ? 0 : 2;
      coords += d.shapes[s].coordCount == want ? 0 : 1;
    }
    ctx.check(d.size == 20.0f && d.shapeCount > 0 && coords == 0, "holo icon " + std::string(mp::enumName(icon)) + " is a 20x20 vector drawing");
    ctx.check((mp::poiGlyph(icon) != nullptr) == (i < mp::EnumNames<mp::PoiCategory>::values.size()), "POI glyph only for POI categories");
  }
  ctx.check(mp::poiGlyph(mp::LabelIcon::Subway)->text != nullptr && std::string(mp::poiGlyph(mp::LabelIcon::Subway)->text) == "M",
            "subway badge glyph is the text M");
}

MAPRAMA_TEST(map_projector_is_the_maplibre_perspective) {
  const double W = 390, H = 500, lat = 37.5445, lng = 127.056;
  const auto pose = [&](double zoom, double pitch, double bearing) {
    mp::MapCameraPose p;
    p.center = mp::LngLat{lng, lat};
    p.zoom = zoom;
    p.pitch = pitch;
    p.bearing = bearing;
    return p;
  };
  const double mpp = cm::mapLibreMetersPerPixel(16, lat);
  const double degPerMeterLng = 1.0 / (111320.0 * std::cos(lat * 3.14159265358979323846 / 180.0));
  {
    const mp::MapProjector p(pose(16, 0, 0), W, H);
    const auto c = p.project(mp::LngLat{lng, lat});
    ctx.check(near(c.x, W / 2, 1e-9) && near(c.y, H / 2, 1e-9) && c.inFront, "centre projects to the view centre");
    const auto e = p.project(mp::LngLat{lng + 100 * mpp * degPerMeterLng, lat});
    ctx.near(e.x - W / 2, 100.0, 0.5, "100 px east (MapLibre ground scale) at pitch 0");
    const auto up = p.project(mp::LngLat{lng, lat}, 50.0);
    ctx.near(up.y, H / 2, 1e-6, "a point above the centre stays at the centre when looking straight down");
  }
  {
    const mp::MapProjector p(pose(16, 0, 90), W, H);
    const auto e = p.project(mp::LngLat{lng + 100 * mpp * degPerMeterLng, lat});
    ctx.near(e.x, W / 2, 0.01, "bearing 90: east is straight ahead (x)");
    ctx.near(e.y, H / 2 - 100, 0.5, "bearing 90: east is up");
  }
  {
    const double pitch = 60, D = 0.5 * H / std::tan(mp::kMapLibreFovRad / 2), s = std::sin(pitch * 3.14159265358979323846 / 180),
                 c = std::cos(pitch * 3.14159265358979323846 / 180);
    const mp::MapProjector p(pose(16, pitch, 0), W, H);
    // A ground point d px north of the centre: y = H/2 - D·d·cos p / (D + d·sin p) (foreshortened, above the centre).
    const double d = 120;
    const double latNorth = lat + d * mpp / 110574.0;  // ~1 px accuracy is enough for this check
    const auto n = p.project(mp::LngLat{lng, latNorth});
    const double mercatorPx = (std::log(std::tan(3.14159265358979323846 / 4 + latNorth * 3.14159265358979323846 / 360)) -
                               std::log(std::tan(3.14159265358979323846 / 4 + lat * 3.14159265358979323846 / 360))) *
                              180 / 3.14159265358979323846 / 360 * 512 * std::pow(2.0, 16);
    ctx.near(n.y, H / 2 - D * mercatorPx * c / (D + mercatorPx * s), 1e-6, "pitched ground point matches the pinhole model");
    ctx.check(n.y < H / 2 && H / 2 - n.y < mercatorPx, "pitched: north is above the centre and foreshortened");
    const auto top = p.project(mp::LngLat{lng, lat}, 100.0);
    ctx.check(top.y < H / 2 && top.inFront, "pitched: a point 100 m above the centre is drawn above it");
    ctx.check(p.project(mp::LngLat{lng, lat + 5.0}).inFront, "a point far ahead (toward the horizon) is in front");
    ctx.check(!p.project(mp::LngLat{lng, lat - 5.0}).inFront, "a point far behind the camera is not in front");
  }
  {
    // Consistency with CameraMath: at pitch 0 the protocol distance d frames 2·d·tan 20° meters over H.
    const double distance = 400;
    const double zoom = cm::distanceToMapLibreZoom(distance, lat, H);
    const mp::MapProjector p(pose(zoom, 0, 0), W, H);
    const double halfSpan = distance * std::tan(20.0 * 3.14159265358979323846 / 180);
    const auto edge = p.project(mp::LngLat{lng, lat + halfSpan / 110574.0});
    ctx.near(edge.y, 0.0, H * 0.01, "distance framing: d·tan 20° north of the target is at the top edge (1 %)");
  }
}

namespace {

/// Answers every pending `measureLabels` with deterministic sizes.
void answerMeasures(Harness& h, std::size_t& answered) {
  for (; answered < h.adapter->measures.size(); ++answered) {
    const auto& [token, items] = h.adapter->measures[answered];
    std::vector<mp::LabelSize> sizes;
    for (const mp::LabelCardContent& c : items) {
      const double chars = static_cast<double>(c.title.size() + (c.showSubtitle ? c.subtitle.size() / 2 : 0));
      sizes.push_back(mp::LabelSize{24 + 5.5 * chars, c.visual == mp::LabelVisual::Holo ? 36.0 : 18.0});
    }
    h.engine->onLabelsMeasured(token, sizes);
  }
}

std::size_t countEvents(const Harness& h, const std::string& type, std::size_t from = 0) { return h.sink->eventsOfType(type, from).size(); }

}  // namespace

MAPRAMA_TEST(labels_session_flow) {
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  const Value* seongsuCase = nullptr;
  for (const Value& wc : fixture.find("worlds")->items()) {
    if (wc.find("name")->asString().find("seongsu") != std::string::npos) seongsuCase = &wc;
  }
  if (!ctx.check(seongsuCase != nullptr, "labels.json has the Seongsu sample")) return;
  const auto& infos = seongsuCase->find("infos")->items();

  Harness h;
  std::size_t answered = 0;
  const Value station = seongsuValue(ctx).find("stations")->items().at(0);
  std::string subwayId;
  for (const Value& info : infos) {
    if (str(info.find("category")) == "subway") subwayId = info.find("id")->asString();
  }
  h.send(initMsg(dataWorld(ctx), std::nullopt, Value::object(), Value::object({{"zoomButtons", true}})));

  // labelsIndex: once per load, engine-web's payload.
  const auto index = h.sink->eventsOfType("labelsIndex");
  ctx.check(index.size() == 1, "init emits one labelsIndex");
  if (!index.empty()) {
    const auto& labels = index[0].find("labels")->items();
    bool same = labels.size() == infos.size();
    for (std::size_t i = 0; same && i < labels.size(); ++i) same = nearJson(labels[i], infos[i]);
    ctx.check(same, "labelsIndex = engine-web's Seongsu labels (" + std::to_string(infos.size()) + ")");
  }

  // Sizes are measured by the platform first; nothing is placed before.
  ctx.check(h.adapter->measures.size() == 1 && h.adapter->measures[0].second.size() > 0, "one measureLabels batch after the load");
  ctx.check(!h.adapter->labelFrames.empty() && h.adapter->labelFrames.back().cards.empty(), "no cards before the sizes are known");
  answerMeasures(h, answered);
  // The station view of the example app.
  const mp::LngLat stationLl = h.engine->worldStore().projection()->toLngLat(mp::WorldPoint{num(station.find("x")), num(station.find("z"))});
  h.send(setCameraMsg(Value::object({{"center", lngLat(stationLl.lng, stationLl.lat)}, {"distance", 300}, {"pitch", 50}, {"bearing", 0}})));
  const mp::LabelFrame holo = h.adapter->labelFrames.back();
  ctx.check(holo.visual == mp::LabelVisual::Holo && holo.tile == mp::LabelTile::White && !holo.night, "default: holo, white tiles by day");
  ctx.check(!holo.cards.empty() && holo.cards.size() <= 60, "holo cards placed (" + std::to_string(holo.cards.size()) + ")");
  std::size_t roads = 0;
  bool inside = true, a11y = true, subway = false;
  const auto exclusions = mp::nativeHudExclusions(390, 500, h.adapter->uis.back());
  std::vector<mp::LabelBox> boxes;
  for (const mp::LabelCard& c : holo.cards) {
    roads += c.content.kind == mp::LabelKind::Road ? 1 : 0;
    inside = inside && c.x - c.width / 2 >= 6 - 1e-9 && c.x + c.width / 2 <= 390 - 6 + 1e-9;
    a11y = a11y && c.content.accessibilityLabel.rfind(c.content.title + ", ", 0) == 0;
    subway = subway || c.id == subwayId;
    const mp::LabelBox box{c.x, c.y, c.width / 2 + 5, c.height / 2 + 4};
    for (const mp::LabelBox& b : boxes) inside = inside && !mp::overlaps(b, box);
    for (const mp::LabelBox& b : exclusions) inside = inside && !mp::overlaps(b, box);
    boxes.push_back(box);
    ctx.check(c.lineY >= c.y + c.height / 2 && c.lineX >= c.x - c.width / 2 && c.lineX <= c.x + c.width / 2,
              "[" + c.id + "] leader line ends under its card");
  }
  ctx.check(roads <= 5, "at most 5 road holo cards");
  ctx.check(inside, "holo cards stay 6 dp inside the edges, off the HUD zones and off each other");
  ctx.check(a11y, "every card has an accessibility label 'name, type'");
  ctx.check(subway, "the station's subway POI (" + subwayId + ") is labelled at the station view");

  // No change -> no new frame.
  const std::size_t framesBefore = h.adapter->labelFrames.size();
  h.engine->frame(0);
  ctx.check(h.adapter->labelFrames.size() == framesBefore, "unchanged placement is not re-sent");

  // setLabels: app style (new sizes measured), no labelsIndex.
  const std::size_t eventsBefore = h.sink->events.size();
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "app"}})}}));
  ctx.check(countEvents(h, "labelsIndex", eventsBefore) == 0, "setLabels does not re-emit labelsIndex (same world)");
  ctx.check(h.adapter->measures.size() == 2, "a new style measures its cards");
  answerMeasures(h, answered);
  const mp::LabelFrame app = h.adapter->labelFrames.back();
  bool rotated = false;
  for (const mp::LabelCard& c : app.cards) rotated = rotated || (c.content.kind == mp::LabelKind::Road && c.angle != 0);
  ctx.check(app.visual == mp::LabelVisual::App && !app.cards.empty(), "app style cards placed (" + std::to_string(app.cards.size()) + ")");
  ctx.check(rotated, "app-style road labels follow the road direction");

  // textOnly: no icons, no subtitles; the accessibility label keeps the type.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "holo"}, {"content", "textOnly"}})}}));
  answerMeasures(h, answered);
  const mp::LabelFrame text = h.adapter->labelFrames.back();
  bool plain = !text.cards.empty();
  for (const mp::LabelCard& c : text.cards) plain = plain && !c.content.showIcon && !c.content.showSubtitle && c.content.accessibilityLabel.find(", ") != std::string::npos;
  ctx.check(plain, "textOnly cards: no icon, no subtitle, accessibility label still 'name, type'");

  // Custom content by id (entries replace each other).
  h.send(Value::object({{"type", "setLabelContent"},
                        {"entries", Value::object({{subwayId, Value::object({{"title", "성수 ★"}, {"subtitle", "custom"}})}})}}));
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"content", "custom"}})}}));
  answerMeasures(h, answered);
  bool custom = false;
  for (const mp::LabelCard& c : h.adapter->labelFrames.back().cards) {
    if (c.id == subwayId) custom = c.content.title == "성수 ★" && c.content.custom && c.content.subtitle == "custom" && c.content.accessibilityLabel == "성수 ★, custom";
  }
  ctx.check(custom, "custom content applied to the subway label");

  // 3D styles map to the closest view style (warned once).
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "ground"}})}}));
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "ground"}})}}));
  ctx.check(h.sink->countLogs("label style \"ground\" is drawn as \"app\"", mp::LogLevel::Warn) == 1, "ground style warned once");
  ctx.check(h.adapter->labelFrames.back().visual == mp::LabelVisual::App, "ground labels drawn as app labels");
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "sign"}})}}));
  ctx.check(h.adapter->labelFrames.back().visual == mp::LabelVisual::Sticker, "sign labels drawn as sticker labels");

  // Night: auto tiles turn black.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object()}}));
  h.send(Value::object({{"type", "setTheme"}, {"theme", Value::object({{"timeOfDay", "night"}})}}));
  answerMeasures(h, answered);
  ctx.check(h.adapter->labelFrames.back().night && h.adapter->labelFrames.back().tile == mp::LabelTile::Black, "night: black icon tiles");

  // Disabled: nothing shown.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"enabled", false}})}}));
  ctx.check(h.adapter->labelFrames.back().cards.empty(), "labels: {enabled: false} hides every card");

  // Detach / attach: unanswered measurements are requested again.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "clean"}})}}));
  const std::size_t measuresBefore = h.adapter->measures.size();
  h.engine->detachMapAdapter();
  h.engine->attachMapAdapter(h.adapter);
  ctx.check(h.adapter->measures.size() == measuresBefore + 1, "re-attach re-requests the unmeasured cards");
  answered = h.adapter->measures.size() - 1;
  answerMeasures(h, answered);
  ctx.check(h.adapter->labelFrames.back().visual == mp::LabelVisual::Clean && !h.adapter->labelFrames.back().cards.empty(),
            "clean labels placed after re-attach");

  // A second load re-emits labelsIndex.
  const std::size_t before2 = h.sink->events.size();
  h.send(initMsg(dataWorld(ctx)));
  ctx.check(countEvents(h, "labelsIndex", before2) == 1, "every world load emits labelsIndex");
  ctx.check(h.sink->errors() == 0, "no error logs");
  appendEmitted(ctx, *h.sink);
}
