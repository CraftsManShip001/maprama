// M5 markers: the port of engine-web's `src/labels/markers.ts` (placement order, collisions, partial
// updates) and the session behaviour (marker cards in the label frame, `marker:press`, the marker boxes as
// label exclusions), plus `ui.contentInset` — the camera anchor, the ornament layout and the HUD zones.
// Emitted envelopes go to --emit (verify-emitted-events).
#include <algorithm>
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/LabelSystem.hpp"
#include "maprama/MarkerIcons.hpp"
#include "maprama/MarkerSystem.hpp"
#include "maprama/Projection.hpp"
#include "maprama/WorldStore.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::json::Value;
using maprama::test::Context;
using namespace maprama::test::maptest;
namespace mp = maprama;
namespace cm = maprama::camera_math;

mp::MarkerCandidate candidate(const std::string& key, double priority = 0, double dT = 0, bool forced = false,
                              bool onScreen = true, mp::LabelBox box = mp::LabelBox{100, 100, 14, 18}) {
  mp::MarkerCandidate c;
  c.key = key;
  c.layerId = "poi";
  c.markerId = key;
  c.priority = priority;
  c.dT = dT;
  c.forced = forced;
  c.onScreen = onScreen;
  c.box = box;
  return c;
}

Value markerSpec(const std::string& id, double lng, double lat, Value extra = Value::object()) {
  Value m = Value::object({{"id", id}, {"coordinate", lngLat(lng, lat)}});
  for (const auto& member : extra.members()) m.set(member.key, member.value);
  return m;
}

Value setMarkerLayerMsg(const std::string& layerId, Value markers, Value extra = Value::object()) {
  Value msg = Value::object({{"type", "setMarkerLayer"}, {"layerId", layerId}, {"markers", std::move(markers)}});
  for (const auto& member : extra.members()) msg.set(member.key, member.value);
  return msg;
}

/// Answers every outstanding `measureLabels` request with a fixed card size (the labels then place).
void answerMeasures(Harness& h, std::size_t& answered) {
  for (; answered < h.adapter->measures.size(); ++answered) {
    const auto& [token, items] = h.adapter->measures[answered];
    std::vector<mp::LabelSize> sizes;
    sizes.reserve(items.size());
    for (const mp::LabelCardContent& c : items) {
      sizes.push_back(mp::LabelSize{40.0 + 6.0 * static_cast<double>(c.title.size()), c.showSubtitle ? 34.0 : 22.0});
    }
    h.engine->onLabelsMeasured(token, sizes);
  }
}

std::vector<mp::LabelCard> markerCards(const mp::LabelFrame& frame) {
  std::vector<mp::LabelCard> out;
  for (const mp::LabelCard& c : frame.cards) {
    if (c.content.visual == mp::LabelVisual::Marker) out.push_back(c);
  }
  return out;
}

const mp::LabelCard* findCard(const mp::LabelFrame& frame, const std::string& markerId) {
  for (const mp::LabelCard& c : frame.cards) {
    if (c.content.visual == mp::LabelVisual::Marker && c.id.size() >= markerId.size() &&
        c.id.compare(c.id.size() - markerId.size(), markerId.size(), markerId) == 0) {
      return &c;
    }
  }
  return nullptr;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------
// Pure placement rules (engine-web `markers.test.ts`)
// ---------------------------------------------------------------------------------------------------------

MAPRAMA_TEST(marker_placement_order) {
  std::vector<mp::MarkerCandidate> list{
      candidate("b", 5, 10), candidate("a", 5, 10), candidate("c", 9, 99),
      candidate("d", 5, 2), candidate("e", -1, 0, true),
  };
  std::vector<std::string> order;
  for (const auto& [key, box] : mp::placeMarkers(list, {})) order.push_back(key);
  // `a` .. `d` share a box, so only the first of them survives the collision pass; the order itself is what
  // `markerBefore` decides, and it is asserted directly.
  std::vector<const mp::MarkerCandidate*> sorted;
  for (const mp::MarkerCandidate& c : list) sorted.push_back(&c);
  std::stable_sort(sorted.begin(), sorted.end(),
                   [](const mp::MarkerCandidate* x, const mp::MarkerCandidate* y) { return mp::markerBefore(*x, *y); });
  std::vector<std::string> keys;
  for (const mp::MarkerCandidate* c : sorted) keys.push_back(c->key);
  ctx.check(keys == std::vector<std::string>({"e", "c", "d", "a", "b"}),
            "forced first, then priority desc, then nearest to the camera target, then key");

  // A lower-priority marker loses the overlap.
  const mp::LabelBox box{100, 100, 14, 18};
  const auto shown = mp::placeMarkers({candidate("low", 0, 0, false, true, box),
                                       candidate("high", 10, 0, false, true, mp::LabelBox{104, 100, 14, 18})},
                                      {});
  ctx.check(shown.size() == 1 && shown[0].first == "high", "a colliding lower-priority marker is dropped");

  // Forced markers ignore the HUD zones and each other.
  const mp::LabelBox hud{195, 20, 195, 30};
  const mp::LabelBox at{195, 20, 14, 18};
  const auto forced = mp::placeMarkers({candidate("plain", 0, 0, false, true, at),
                                        candidate("always", 0, 0, true, true, at),
                                        candidate("selected", 0, 0, true, true, mp::LabelBox{200, 20, 14, 18})},
                                       {hud});
  ctx.check(forced.size() == 2 && forced[0].first == "always" && forced[1].first == "selected",
            "alwaysVisible / selected markers are never dropped, plain ones are");
  ctx.check(mp::placeMarkers({candidate("off", 0, 0, true, false)}, {}).empty(), "off-screen markers are skipped");
  ctx.check(std::fabs(mp::markerAspect(mp::MarkerShape::Pin) - 24.0 / 32.0) < 1e-12 &&
                mp::markerAspect(mp::MarkerShape::Dot) == 1.0,
            "base shape aspects match engine-web's viewBoxes");
}

// ---------------------------------------------------------------------------------------------------------
// Partial updates (the count test the design asks for)
// ---------------------------------------------------------------------------------------------------------

MAPRAMA_TEST(marker_partial_updates) {
  mp::Result<mp::Projection> projection = mp::Projection::create(mp::ProjectionOptions{mp::LngLat{127.0, 37.5}, 8.0});
  if (!ctx.check(projection.ok(), "test projection")) return;
  const mp::Projection& proj = *projection.value;

  const auto base = [](const char* color) {
    Value markers = Value::array();
    markers.push(markerSpec("a", 127.0005, 37.5, Value::object({{"color", color}, {"accessibilityLabel", "Alpha"}})));
    markers.push(markerSpec("b", 127.0010, 37.5,
                            Value::object({{"color", color},
                                           {"icon", Value::object({{"uri", "data:image/svg+xml,<svg/>"}})},
                                           {"accessibilityLabel", "Bravo"}})));
    markers.push(markerSpec("c", 127.0015, 37.5, Value::object({{"color", color}, {"icon", "dot"}})));
    return markers;
  };

  mp::MarkerSystem markers;
  markers.setLayer(setMarkerLayerMsg("poi", base("#112233"), Value::object({{"selectedId", "a"}})), &proj);
  ctx.check(markers.stats().viewsCreated == 3 && markers.stats().iconLoads == 1,
            "first layer: 3 views created, 1 icon loaded");

  // The 45 s server tick of the example app: only colours and the selection change.
  markers.setLayer(setMarkerLayerMsg("poi", base("#FF8800"), Value::object({{"selectedId", "c"}})), &proj);
  ctx.check(markers.stats().viewsCreated == 3 && markers.stats().iconLoads == 1,
            "a colour + selection change creates no view and reloads no icon");

  // A changed icon uri is the only thing that loads an image.
  Value swapped = Value::array();
  swapped.push(markerSpec("a", 127.0005, 37.5));
  swapped.push(markerSpec("b", 127.0010, 37.5, Value::object({{"icon", Value::object({{"uri", "https://cdn.example/pin.svg"}})}})));
  swapped.push(markerSpec("c", 127.0015, 37.5, Value::object({{"icon", "dot"}})));
  markers.setLayer(setMarkerLayerMsg("poi", swapped), &proj);
  ctx.check(markers.stats().viewsCreated == 3 && markers.stats().iconLoads == 2, "only a changed icon loads an image");

  // Dropping a marker recycles its view; adding it back reuses it instead of creating one.
  Value two = Value::array();
  two.push(markerSpec("a", 127.0005, 37.5));
  two.push(markerSpec("b", 127.0010, 37.5, Value::object({{"icon", Value::object({{"uri", "https://cdn.example/pin.svg"}})}})));
  markers.setLayer(setMarkerLayerMsg("poi", two), &proj);
  markers.setLayer(setMarkerLayerMsg("poi", swapped), &proj);
  ctx.check(markers.stats().viewsCreated == 3, "a recycled view is reused (no new view)");
  ctx.check(markers.layerIds() == std::vector<std::string>({"poi"}), "one layer");
  ctx.check(markers.removeLayer("poi") && markers.empty() && !markers.removeLayer("poi"), "removeLayer forgets the layer");
}

// ---------------------------------------------------------------------------------------------------------
// Session behaviour
// ---------------------------------------------------------------------------------------------------------

MAPRAMA_TEST(marker_session_flow) {
  Harness h;
  std::size_t answered = 0;
  h.send(initMsg(dataWorld(ctx), std::nullopt, Value::object(), Value::object({{"attribution", true}})));
  answerMeasures(h, answered);
  const mp::Projection& proj = *h.engine->worldStore().projection();
  const mp::CameraState camera = h.engine->cameraState();

  // 40 pins in a 8 x 5 grid around the camera target, 30 m apart: the target scale of the design.
  const mp::WorldPoint target = proj.toWorld(camera.center);
  Value markers = Value::array();
  std::vector<std::string> ids;
  for (int i = 0; i < 40; ++i) {
    const double x = target.x + ((i % 8) - 3.5) * 4.0, z = target.z + ((i / 8) - 2.0) * 4.0;
    const mp::LngLat ll = proj.toLngLat(mp::WorldPoint{x, z});
    const std::string id = "m" + std::to_string(i);
    ids.push_back(id);
    Value extra = Value::object({{"color", i % 2 == 0 ? "#2F5BEA" : "#E0452F"},
                                 {"priority", 60 - i},
                                 {"accessibilityLabel", id + ", blue"}});
    if (i % 9 == 0) extra.set("alwaysVisible", true);
    if (i % 7 == 0) extra.set("icon", Value::object({{"uri", "data:image/svg+xml,<svg/>"}}));
    markers.push(markerSpec(id, ll.lng, ll.lat, std::move(extra)));
  }
  // The hero pin sits exactly on the camera target and is the selected one.
  markers.push(markerSpec("hero", camera.center.lng, camera.center.lat,
                          Value::object({{"alwaysVisible", true}, {"priority", 100}, {"accessibilityLabel", "Hero, blue"}})));
  h.send(setMarkerLayerMsg("poi", markers, Value::object({{"selectedId", "hero"}, {"selectedScale", 1.3}, {"size", 40}})));
  answerMeasures(h, answered);

  const mp::LabelFrame frame = h.adapter->labelFrames.back();
  const std::vector<mp::LabelCard> cards = markerCards(frame);
  ctx.check(!cards.empty(), "marker cards are placed (" + std::to_string(cards.size()) + " of 41)");
  const mp::LabelCard* hero = findCard(frame, "hero");
  if (ctx.check(hero != nullptr, "the selected hero pin is placed")) {
    ctx.near(hero->height, 40.0 * 1.3, 1e-9, "the selected marker uses selectedScale");
    ctx.near(hero->width, 40.0 * 1.3 * 24.0 / 32.0, 1e-9, "pin aspect 24/32");
    ctx.check(hero->content.selected && hero->content.color == 0x2F5BEA, "selected flag and default colour reach the platform");
    ctx.check(hero->content.accessibilityLabel == "Hero, blue", "the accessibility label reaches the platform");
    // `anchor: "bottom"` (the default): the card hangs above the coordinate, so its centre is half a card up.
    const mp::MapProjector projector(h.adapter->moves.back().first, 390, 500);
    const mp::MapProjector::Point at = projector.project(camera.center, 0.09 * 8.0);
    ctx.near(hero->x, at.x, 0.01, "the pin tip sits on the coordinate (x)");
    ctx.near(hero->y, at.y - hero->height / 2, 0.01, "bottom anchor: the card hangs above the coordinate");

    // A press on the pin emits `marker:press` only.
    const std::size_t eventsBefore = h.sink->events.size();
    const std::size_t queriesBefore = h.adapter->queries.size();
    h.engine->tap(hero->x, hero->y);
    const auto presses = h.sink->eventsOfType("marker:press", eventsBefore);
    ctx.check(presses.size() == 1, "a press on a marker emits marker:press");
    ctx.check(h.adapter->queries.size() == queriesBefore, "and never queries a building (no building:press / map:press)");
    if (!presses.empty()) {
      ctx.check(presses[0].find("layerId")->asString() == "poi" && presses[0].find("markerId")->asString() == "hero",
                "marker:press names the layer and the marker");
      ctx.near(presses[0].find("point")->find("x")->asNumber(), at.x, 0.01, "marker:press.point is the marker anchor (x)");
      ctx.near(presses[0].find("point")->find("y")->asNumber(), at.y, 0.01, "marker:press.point is the marker anchor (y)");
      ctx.near(presses[0].find("coordinate")->find("lng")->asNumber(), camera.center.lng, 1e-9, "marker:press.coordinate");
    }
  }

  // Labels never cover a marker: the marker boxes are exclusions of the label pass.
  bool clear = true;
  for (const mp::LabelCard& label : frame.cards) {
    if (label.content.visual == mp::LabelVisual::Marker) continue;
    const mp::LabelBox lb{label.x, label.y, label.width / 2, label.height / 2};
    for (const mp::LabelCard& m : cards) {
      clear = clear && !mp::overlaps(lb, mp::LabelBox{m.x, m.y, m.width / 2 + 2, m.height / 2 + 2});
    }
  }
  ctx.check(clear, "no label card overlaps a marker");

  // The partial update the design promises, end to end: only colours and the selection change.
  const mp::MarkerStats statsBefore = h.engine->markerStats();
  Value recoloured = Value::array();
  for (const Value& m : markers.items()) {
    Value copy = m;
    copy.set("color", "#0F9D8C");
    recoloured.push(std::move(copy));
  }
  h.send(setMarkerLayerMsg("poi", recoloured, Value::object({{"selectedId", "m3"}, {"selectedScale", 1.3}, {"size", 40}})));
  const mp::MarkerStats statsAfter = h.engine->markerStats();
  ctx.check(statsAfter.viewsCreated == statsBefore.viewsCreated && statsAfter.iconLoads == statsBefore.iconLoads,
            "a colour + selection change creates no view and reloads no icon (session path)");
  const mp::LabelFrame after = h.adapter->labelFrames.back();
  const mp::LabelCard* recolouredHero = findCard(after, "hero");
  ctx.check(recolouredHero != nullptr && recolouredHero->content.color == 0x0F9D8C && !recolouredHero->content.selected,
            "the new tint and the cleared selection reach the platform");
  const mp::LabelCard* m3 = findCard(after, "m3");
  ctx.check(m3 != nullptr && m3->content.selected, "the newly selected marker is drawn selected");
  if (recolouredHero != nullptr && hero != nullptr) {
    ctx.check(recolouredHero->content.key == hero->content.key, "the content key is unchanged (no view rebuild, no icon reload)");
  }

  // removeMarkerLayer: no cards, nothing pressable.
  h.send(Value::object({{"type", "removeMarkerLayer"}, {"layerId", "poi"}}));
  ctx.check(markerCards(h.adapter->labelFrames.back()).empty(), "removeMarkerLayer removes every card");
  const std::size_t eventsAfterRemove = h.sink->events.size();
  const std::size_t queriesAfterRemove = h.adapter->queries.size();
  h.engine->tap(195, 250);
  ctx.check(h.sink->eventsOfType("marker:press", eventsAfterRemove).empty() &&
                h.adapter->queries.size() == queriesAfterRemove + 1,
            "after the layer is gone a press goes to the building query again");
  appendEmitted(ctx, *h.sink);
}

// ---------------------------------------------------------------------------------------------------------
// ui.contentInset
// ---------------------------------------------------------------------------------------------------------

MAPRAMA_TEST(content_inset_camera_and_ornaments) {
  // The HUD zones move with the inset (engine-web `hudExclusions(vw, vh, ui, insets)`).
  mp::MapUiState ui;
  ui.attribution = true;
  ui.logo = true;
  ui.scaleBar = true;
  ui.scaleBarWidth = 60;
  ui.zoomButtons = true;
  const std::vector<mp::LabelBox> plain = mp::nativeHudExclusions(390, 800, ui);
  ui.inset.bottom = 380;
  const std::vector<mp::LabelBox> inset = mp::nativeHudExclusions(390, 800, ui);
  ctx.check(inset.size() == plain.size(), "the same ornaments produce the same number of zones");
  double lowestPlain = 0, lowestInset = 0;
  for (const mp::LabelBox& b : plain) lowestPlain = std::max(lowestPlain, b.y);
  for (const mp::LabelBox& b : inset) lowestInset = std::max(lowestInset, b.y - b.hh);
  ctx.check(lowestPlain > 700, "without an inset the attribution zone sits at the bottom edge");
  ctx.check(lowestInset < 800 - 380 + 1e-9, "with a 380 dp bottom inset every ornament zone is above the sheet");

  // The camera anchor: the protocol centre ends up under the middle of the visible area.
  Harness h;
  std::size_t answered = 0;
  h.send(initMsg(dataWorld(ctx), std::nullopt, Value::object(), Value::object({{"attribution", true}})));
  answerMeasures(h, answered);
  const mp::CameraState before = h.engine->cameraState();
  const mp::MapCameraPose posePlain = h.adapter->moves.back().first;
  ctx.near(posePlain.center.lat, before.center.lat, 1e-12, "without an inset the map centre is the protocol centre");

  h.send(Value::object({{"type", "setUi"},
                        {"ui", Value::object({{"attribution", true},
                                              {"contentInset", Value::object({{"bottom", 250}})}})}}));
  const mp::MapUiState pushed = h.adapter->uis.back();
  ctx.near(pushed.inset.bottom, 250, 1e-12, "the inset reaches the platform ornaments");
  const mp::MapCameraPose poseInset = h.adapter->moves.back().first;
  // A bottom inset leaves the upper half visible, so the protocol centre has to appear higher on screen:
  // the map itself looks at a point *nearer the camera* (engine-web looks at `anchor - insetShift`).
  ctx.check(poseInset.center.lat < posePlain.center.lat - 1e-9,
            "a bottom content inset moves the MapLibre camera so the protocol centre stays in the visible half");
  // The decisive check: with that pose the protocol centre projects onto the middle of the visible area, and
  // the core's own projector (which labels and markers use) agrees with it.
  const mp::MapProjector projector(poseInset, 390, 500);
  const mp::MapProjector::Point at = projector.project(before.center, 0.0);
  ctx.near(at.x, 195, 1.0, "the protocol centre projects onto the horizontal middle of the visible area");
  ctx.near(at.y, (500.0 - 250.0) / 2.0, 1.5, "and onto the vertical middle of the visible half");
  ctx.check(std::fabs(h.engine->cameraState().center.lat - before.center.lat) < 1e-9,
            "the reported CameraState.center is unchanged (it is the visible-area centre)");
  // `camera:idle` and the labels already measured against the visible area; with the inset applied the
  // ornaments do too, which is what keeps the OSM attribution out from under an app sheet.
  ctx.check(!h.sink->loggedContaining("contentInset is only partly implemented", mp::LogLevel::Warn),
            "no 'partly implemented' warning any more");

  // `camera:idle` must still describe a box *around the centre it reports*. The ground corners come back
  // measured from the pose centre (optical axis), so forgetting to undo the shift pushes the whole box a
  // shift away from its own centre — an app querying `nearby(centre, radius)` would then silently drop the
  // POIs just above the sheet, which is exactly the row the sheet is about to show.
  h.send(Value::object({{"type", "subscribe"}, {"topic", "camera:idle"}, {"throttleMs", 0}}));
  h.run(200);
  const std::vector<Value> idle = h.sink->eventsOfType("camera:idle");
  if (ctx.check(!idle.empty(), "camera:idle arrives with a content inset set")) {
    const Value& ev = idle.back();
    const Value& b = *ev.find("bounds");
    const double neLat = b.find("ne")->find("lat")->asNumber(), swLat = b.find("sw")->find("lat")->asNumber();
    const double neLng = b.find("ne")->find("lng")->asNumber(), swLng = b.find("sw")->find("lng")->asNumber();
    const double lat = ev.find("camera")->find("center")->find("lat")->asNumber();
    const double lng = ev.find("camera")->find("center")->find("lng")->asNumber();
    ctx.check(lat <= neLat && lat >= swLat, "the reported centre is inside the reported bounds (latitude)");
    ctx.check(lng <= neLng && lng >= swLng, "the reported centre is inside the reported bounds (longitude)");
    // And the radius reaches the farthest of those corners, measured from that same centre.
    const double metersPerDegLat = 111320.0;
    const double farLat = std::max(neLat - lat, lat - swLat) * metersPerDegLat;
    ctx.check(ev.find("radiusMeters")->asNumber() >= farLat - 1.0,
              "radiusMeters reaches the farthest edge of its own bounds");
  }
  appendEmitted(ctx, *h.sink);
}

// ---------------------------------------------------------------------------------------------------------
// Custom icons: the shared SVG subset both platforms replay (neither can decode SVG itself)
// ---------------------------------------------------------------------------------------------------------

MAPRAMA_TEST(marker_icon_svg_subset) {
  // The example app's star pin, exactly as `example/app/markers.tsx` ships it.
  const std::string star =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+"
      "PHBhdGggZD0iTTEyIDIuNmwyLjcgNS42IDYuMS45LTQuNCA0LjMgMSA2LjEtNS40LTIuOS01LjQgMi45IDEtNi4xTDMuMiA5LjFsNi4xLS45eiIg"
      "ZmlsbD0iIzFFMjUzMyIvPjwvc3ZnPg==";
  const std::optional<mp::VectorImage> starImage = mp::parseSvgDataUri(star);
  if (ctx.check(starImage.has_value(), "the example app's base64 SVG star pin parses")) {
    ctx.check(starImage->width == 24 && starImage->height == 24, "viewBox 0 0 24 24");
    ctx.check(starImage->paths.size() == 1 && starImage->paths[0].hasFill && starImage->paths[0].fill == 0x1E2533 &&
                  !starImage->paths[0].hasStroke,
              "one filled path in #1E2533");
    ctx.check(starImage->paths[0].ops.front() == 'M' && starImage->paths[0].ops.back() == 'Z' &&
                  starImage->paths[0].ops.find('L') != std::string::npos,
              "relative linetos become absolute M/L/Z");
  }

  // The camera pin: a stroked path plus a filled circle (the circle becomes four cubics).
  const std::string camera =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+"
      "PHBhdGggZD0iTTQgOGg0bDEuNi0yaDQuOEwxNiA4aDR2MTFINHoiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFFMjUzMyIgc3Ryb2tlLXdpZHRoPSIy"
      "IiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMy40IiByPSIzLjIiIGZpbGw9IiMxRTI1MzMiLz48L3N2Zz4=";
  const std::optional<mp::VectorImage> cameraImage = mp::parseSvgDataUri(camera);
  if (ctx.check(cameraImage.has_value(), "the example app's camera pin parses")) {
    ctx.check(cameraImage->paths.size() == 2, "path + circle");
    ctx.check(!cameraImage->paths[0].hasFill && cameraImage->paths[0].hasStroke &&
                  cameraImage->paths[0].strokeWidth == 2.0f && cameraImage->paths[0].roundJoin,
              "fill=none, stroke #1E2533 2 dp, round joins");
    ctx.check(cameraImage->paths[1].hasFill && cameraImage->paths[1].ops == "MCCCCZ", "the circle is four cubics");
  }

  // `currentColor` follows the marker tint, and the plain (percent-encoded) data form works too.
  const std::optional<mp::VectorImage> current =
      mp::parseSvgDataUri("data:image/svg+xml,%3Csvg viewBox=%220 0 10 10%22%3E%3Crect width=%228%22 height=%228%22 fill=%22currentColor%22/%3E%3C/svg%3E");
  ctx.check(current && current->paths.size() == 1 && current->paths[0].fillCurrent, "currentColor is reported to the platform");

  // Fails closed: arcs, gradients, transforms and groups are not guessed at.
  ctx.check(!mp::parseSvg("<svg viewBox=\"0 0 10 10\"><path d=\"M0 0A5 5 0 0 1 10 10\"/></svg>"), "an arc fails the parse");
  ctx.check(!mp::parseSvg("<svg viewBox=\"0 0 10 10\"><g><rect width=\"4\" height=\"4\"/></g></svg>"), "a group fails the parse");
  ctx.check(!mp::parseSvg("<svg viewBox=\"0 0 10 10\"><rect width=\"4\" height=\"4\" transform=\"scale(2)\"/></svg>"),
            "a transform fails the parse");
  ctx.check(!mp::parseSvgDataUri("https://cdn.example/pin.svg"), "a network URI is left to the platform decoder");
  ctx.check(!mp::parseSvgDataUri("data:image/png;base64,iVBORw0KGgo="), "a raster data URI is left to the platform decoder");
  const std::optional<mp::DataUri> png = mp::parseDataUri("data:image/png;base64,iVBORw0KGgo=");
  ctx.check(png && png->mediaType == "image/png" && png->bytes.size() == 8, "parseDataUri hands the platform the raw bytes");
}
