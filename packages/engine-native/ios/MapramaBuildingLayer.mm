#import "MapramaBuildingLayer.h"

#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#import <os/log.h>

#include <algorithm>
#include <array>
#include <mutex>
#include <vector>

NSString *const MapramaBuildingLayerIdentifier = @"maprama-buildings-3d";

namespace {

os_log_t layerLog() {
  static os_log_t log = os_log_create("dev.maprama.engine", "building-layer");
  return log;
}

/// Uniforms shared by both pipelines (std140-compatible layout, 112 bytes).
struct LayerUniforms {
  float mvp[16];
  float lightPos[4];    // xyz, w = intensity
  float lightColor[4];  // rgb, w = window lights
  float viewport[4];    // width px, height px, line half-width px, 0
};

// Same math as the GLSL ES shaders of the Android layer (maprama_building_layer.cpp): MapLibre's extrusion
// lighting (`fill_extrusion.vertex.glsl`) per fragment, engine-web's facade window layouts, lit windows at
// night, screen-space outline quads.
NSString *const kShaderSource = @R"MSL(
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
  float4x4 mvp;
  float4 lightPos;
  float4 lightColor;
  float4 viewport;
};

struct MeshIn {
  float3 position [[attribute(0)]];
  float4 normal [[attribute(1)]];
  float4 color [[attribute(2)]];
  float2 facade [[attribute(3)]];
  float shade [[attribute(4)]];
  float2 cell [[attribute(5)]];
  float4 window [[attribute(6)]];
  float4 glass [[attribute(7)]];
};

struct MeshOut {
  float4 position [[position]];
  float3 color;
  float3 normal;
  float2 facade;
  float shade;
  float2 cell [[flat]];
  float4 window [[flat]];
  float4 glass [[flat]];
  int pattern [[flat]];
};

vertex MeshOut mesh_vertex(MeshIn in [[stage_in]], constant Uniforms& u [[buffer(1)]]) {
  MeshOut out;
  out.position = u.mvp * float4(in.position, 1.0);
  out.color = in.color.rgb;
  out.normal = in.normal.xyz;
  out.facade = in.facade;
  out.shade = in.shade;
  out.cell = in.cell;
  out.window = in.window;
  out.glass = in.glass;
  out.pattern = int(rint(in.normal.w * 127.0));
  return out;
}

static float3 extrusionLight(float3 color, float3 n, float shade, constant Uniforms& u) {
  const float colorvalue = dot(color, float3(0.2126, 0.7152, 0.0722));
  color += 0.03;
  const float intensity = u.lightPos.w;
  float directional = clamp(dot(n, u.lightPos.xyz), 0.0, 1.0);
  directional = mix(1.0 - intensity, max(1.0 - colorvalue + intensity, 1.0), directional);
  directional *= shade;
  const float3 lc = u.lightColor.rgb;
  return clamp(color * directional * lc, mix(float3(0.0), float3(0.3), 1.0 - lc), float3(1.0));
}

static float span(float lo, float hi, float x, float w) {
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

static float hash21(float2 p) {
  p = fract(p * float2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

fragment float4 mesh_fragment(MeshOut in [[stage_in]], constant Uniforms& u [[buffer(1)]]) {
  const float3 n = normalize(in.normal);
  const float3 wall = extrusionLight(in.color, n, in.shade, u);
  if (in.pattern < 0 || in.cell.x <= 0.0 || in.cell.y <= 0.0) return float4(wall, 1.0);
  const float2 c = in.facade / in.cell;
  const float2 f = fract(c);
  const float2 w = max(fwidth(c), float2(1e-4));
  const float4 r = in.window;
  float win;
  float coverage;
  if (in.pattern == 1) {
    win = span(r.z, r.w, f.y, w.y) * span(r.x * 0.5, 1.0 - r.x * 0.5, f.x, w.x);
    coverage = (r.w - r.z) * (1.0 - r.x);
  } else if (in.pattern == 2) {
    win = span(r.x, 1.0 + w.x, f.x, w.x) * span(r.z, 1.0 + w.y, f.y, w.y);
    coverage = (1.0 - r.x) * (1.0 - r.z);
  } else {
    win = span(r.x, r.y, f.x, w.x) * span(r.z, r.w, f.y, w.y);
    coverage = (r.y - r.x) * (r.w - r.z);
  }
  const float fade = smoothstep(0.35, 0.8, max(w.x, w.y));
  win = mix(win, coverage, fade);
  float3 glass = extrusionLight(in.glass.rgb, n, in.shade, u);
  const float probability = in.pattern == 3 ? 0.8 : 0.4;
  float lit = step(hash21(floor(c) + in.glass.a * 37.0), probability);
  lit = mix(lit, probability, fade) * u.lightColor.w;
  glass = mix(glass, float3(1.0, 0.82, 0.54), clamp(lit * 0.9, 0.0, 1.0));
  return float4(mix(wall, glass, win), 1.0);
}

struct LineIn {
  float3 position [[attribute(0)]];
  float3 other [[attribute(1)]];
  float side [[attribute(2)]];
  float4 color [[attribute(3)]];
};

struct LineOut {
  float4 position [[position]];
  float4 color;
};

vertex LineOut line_vertex(LineIn in [[stage_in]], constant Uniforms& u [[buffer(1)]]) {
  float4 a = u.mvp * float4(in.position, 1.0);
  const float4 b = u.mvp * float4(in.other, 1.0);
  const float2 half_size = u.viewport.xy * 0.5;
  const float2 sa = a.xy / a.w * half_size;
  const float2 sb = b.xy / b.w * half_size;
  float2 dir = sb - sa;
  const float len = length(dir);
  dir = len > 1e-6 ? dir / len : float2(1.0, 0.0);
  const float2 offset = (float2(-dir.y, dir.x) * in.side - dir) * u.viewport.z;
  a.xy += offset / half_size * a.w;
  LineOut out;
  out.position = a;
  out.color = in.color;
  return out;
}

fragment float4 line_fragment(LineOut in [[stage_in]]) { return in.color; }
)MSL";

/// MLNMatrix4 (fields m00…m33 in the order MapLibre copies its column-major array) -> array.
std::array<double, 16> matrixArray(MLNMatrix4 m) {
  return {m.m00, m.m01, m.m02, m.m03, m.m10, m.m11, m.m12, m.m13, m.m20, m.m21, m.m22, m.m23, m.m30, m.m31, m.m32, m.m33};
}

/// Rolling frame statistics (logged every `kStatsFrames` drawn frames).
constexpr int kStatsFrames = 240;

}  // namespace

@implementation MapramaBuildingLayer {
  std::mutex _mutex;
  std::shared_ptr<const maprama::BuildingLayerData> _pending;
  std::shared_ptr<const maprama::BuildingLayerData> _drawn;

  id<MTLDevice> _device;
  id<MTLRenderPipelineState> _meshPipeline;
  id<MTLRenderPipelineState> _linePipeline;
  id<MTLDepthStencilState> _meshDepth;
  id<MTLDepthStencilState> _lineDepth;
  MTLPixelFormat _colorFormat;
  MTLPixelFormat _depthFormat;
  MTLPixelFormat _stencilFormat;
  NSUInteger _sampleCount;
  BOOL _pipelineFailed;

  id<MTLBuffer> _vertices;
  id<MTLBuffer> _indices;
  id<MTLBuffer> _lineVertices;
  id<MTLBuffer> _lineIndices;
  NSUInteger _indexCount;
  NSUInteger _lineIndexCount;
  std::uint64_t _uploadedVersion;

  // Frame timing (main thread + Metal completion handlers).
  std::vector<double> _intervals;
  std::vector<double> _encodeMs;
  std::shared_ptr<std::vector<double>> _gpuMs;
  std::shared_ptr<std::mutex> _gpuMutex;
  CFTimeInterval _lastDraw;
}

- (instancetype)initWithIdentifier:(NSString *)identifier {
  if (self = [super initWithIdentifier:identifier]) {
    _gpuMs = std::make_shared<std::vector<double>>();
    _gpuMutex = std::make_shared<std::mutex>();
  }
  return self;
}

- (void)setData:(std::shared_ptr<const maprama::BuildingLayerData>)data {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    _pending = std::move(data);
  }
  [self setNeedsDisplay];
}

- (void)didMoveToMapView:(MLNMapView *)mapView {
  os_log_info(layerLog(), "building layer attached");
}

- (void)willMoveFromMapView:(MLNMapView *)mapView {
  _meshPipeline = nil;
  _linePipeline = nil;
  _meshDepth = nil;
  _lineDepth = nil;
  _vertices = nil;
  _indices = nil;
  _lineVertices = nil;
  _lineIndices = nil;
  _uploadedVersion = 0;
  _device = nil;
}

- (BOOL)ensurePipelinesForDevice:(id<MTLDevice>)device pass:(MTLRenderPassDescriptor *)pass {
  const MTLPixelFormat color = pass.colorAttachments[0].texture.pixelFormat;
  const MTLPixelFormat depth = pass.depthAttachment.texture ? pass.depthAttachment.texture.pixelFormat : MTLPixelFormatInvalid;
  const MTLPixelFormat stencil = pass.stencilAttachment.texture ? pass.stencilAttachment.texture.pixelFormat : MTLPixelFormatInvalid;
  const NSUInteger samples = MAX((NSUInteger)1, pass.colorAttachments[0].texture.sampleCount);
  if (_meshPipeline && device == _device && color == _colorFormat && depth == _depthFormat && stencil == _stencilFormat &&
      samples == _sampleCount) {
    return YES;
  }
  if (_pipelineFailed && device == _device) return NO;
  _device = device;
  _colorFormat = color;
  _depthFormat = depth;
  _stencilFormat = stencil;
  _sampleCount = samples;

  NSError *error = nil;
  id<MTLLibrary> library = [device newLibraryWithSource:kShaderSource options:nil error:&error];
  if (library == nil) {
    os_log_error(layerLog(), "shader compile failed: %{public}@", error.localizedDescription);
    _pipelineFailed = YES;
    return NO;
  }

  MTLVertexDescriptor *meshLayout = [MTLVertexDescriptor vertexDescriptor];
  const struct {
    MTLVertexFormat format;
    NSUInteger offset;
  } meshAttrs[] = {
      {MTLVertexFormatFloat3, offsetof(maprama::BuildingMeshVertex, position)},
      {MTLVertexFormatChar4Normalized, offsetof(maprama::BuildingMeshVertex, normal)},
      {MTLVertexFormatUChar4Normalized, offsetof(maprama::BuildingMeshVertex, color)},
      {MTLVertexFormatFloat2, offsetof(maprama::BuildingMeshVertex, facade)},
      {MTLVertexFormatFloat, offsetof(maprama::BuildingMeshVertex, shade)},
      {MTLVertexFormatFloat2, offsetof(maprama::BuildingMeshVertex, cell)},
      {MTLVertexFormatUChar4Normalized, offsetof(maprama::BuildingMeshVertex, window)},
      {MTLVertexFormatUChar4Normalized, offsetof(maprama::BuildingMeshVertex, glass)},
  };
  for (NSUInteger i = 0; i < sizeof meshAttrs / sizeof meshAttrs[0]; ++i) {
    meshLayout.attributes[i].format = meshAttrs[i].format;
    meshLayout.attributes[i].offset = meshAttrs[i].offset;
    meshLayout.attributes[i].bufferIndex = 0;
  }
  meshLayout.layouts[0].stride = sizeof(maprama::BuildingMeshVertex);

  MTLVertexDescriptor *lineLayout = [MTLVertexDescriptor vertexDescriptor];
  const struct {
    MTLVertexFormat format;
    NSUInteger offset;
  } lineAttrs[] = {
      {MTLVertexFormatFloat3, offsetof(maprama::BuildingLineVertex, position)},
      {MTLVertexFormatFloat3, offsetof(maprama::BuildingLineVertex, other)},
      {MTLVertexFormatFloat, offsetof(maprama::BuildingLineVertex, side)},
      {MTLVertexFormatUChar4Normalized, offsetof(maprama::BuildingLineVertex, color)},
  };
  for (NSUInteger i = 0; i < sizeof lineAttrs / sizeof lineAttrs[0]; ++i) {
    lineLayout.attributes[i].format = lineAttrs[i].format;
    lineLayout.attributes[i].offset = lineAttrs[i].offset;
    lineLayout.attributes[i].bufferIndex = 0;
  }
  lineLayout.layouts[0].stride = sizeof(maprama::BuildingLineVertex);

  const auto makePipeline = [&](NSString *vs, NSString *fs, MTLVertexDescriptor *layout) -> id<MTLRenderPipelineState> {
    MTLRenderPipelineDescriptor *desc = [[MTLRenderPipelineDescriptor alloc] init];
    desc.vertexFunction = [library newFunctionWithName:vs];
    desc.fragmentFunction = [library newFunctionWithName:fs];
    desc.vertexDescriptor = layout;
    desc.colorAttachments[0].pixelFormat = color;
    desc.depthAttachmentPixelFormat = depth;
    desc.stencilAttachmentPixelFormat = stencil;
    desc.rasterSampleCount = samples;
    NSError *pipelineError = nil;
    id<MTLRenderPipelineState> state = [device newRenderPipelineStateWithDescriptor:desc error:&pipelineError];
    if (state == nil) os_log_error(layerLog(), "pipeline %{public}@ failed: %{public}@", vs, pipelineError.localizedDescription);
    return state;
  };
  _meshPipeline = makePipeline(@"mesh_vertex", @"mesh_fragment", meshLayout);
  _linePipeline = makePipeline(@"line_vertex", @"line_fragment", lineLayout);

  MTLDepthStencilDescriptor *depthDesc = [[MTLDepthStencilDescriptor alloc] init];
  depthDesc.depthCompareFunction = MTLCompareFunctionLessEqual;
  depthDesc.depthWriteEnabled = YES;
  _meshDepth = [device newDepthStencilStateWithDescriptor:depthDesc];
  depthDesc.depthWriteEnabled = NO;
  _lineDepth = [device newDepthStencilStateWithDescriptor:depthDesc];

  _pipelineFailed = _meshPipeline == nil || _linePipeline == nil;
  if (!_pipelineFailed) {
    os_log_info(layerLog(), "pipelines ready (color %lu, depth %lu, stencil %lu, samples %lu)", (unsigned long)color,
                (unsigned long)depth, (unsigned long)stencil, (unsigned long)samples);
  }
  return !_pipelineFailed;
}

- (void)uploadIfNeeded:(const std::shared_ptr<const maprama::BuildingLayerData> &)data device:(id<MTLDevice>)device {
  if (!data || data->version == _uploadedVersion) return;
  const auto buffer = [&](const void *bytes, NSUInteger length) -> id<MTLBuffer> {
    return length > 0 ? [device newBufferWithBytes:bytes length:length options:MTLResourceStorageModeShared] : nil;
  };
  _vertices = buffer(data->vertices.data(), data->vertices.size() * sizeof(maprama::BuildingMeshVertex));
  _indices = buffer(data->indices.data(), data->indices.size() * sizeof(std::uint32_t));
  _lineVertices = buffer(data->lineVertices.data(), data->lineVertices.size() * sizeof(maprama::BuildingLineVertex));
  _lineIndices = buffer(data->lineIndices.data(), data->lineIndices.size() * sizeof(std::uint32_t));
  _indexCount = data->indices.size();
  _lineIndexCount = data->lineIndices.size();
  _uploadedVersion = data->version;
  os_log_info(layerLog(), "uploaded v%llu: %lu vertices, %lu triangles, %lu outline vertices", data->version,
              (unsigned long)data->vertices.size(), (unsigned long)(data->indices.size() / 3),
              (unsigned long)data->lineVertices.size());
}

- (void)drawInMapView:(MLNMapView *)mapView withContext:(MLNStyleLayerDrawingContext)context {
  id<MTLRenderCommandEncoder> encoder = self.renderEncoder;
  MTLRenderPassDescriptor *pass = self.renderPassDesc;
  if (encoder == nil || pass == nil) return;
  const CFTimeInterval start = CACurrentMediaTime();

  std::shared_ptr<const maprama::BuildingLayerData> data;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_pending) _drawn = _pending;
    data = _drawn;
  }
  if (!data || data->indices.empty()) return;
  id<MTLDevice> device = encoder.device;
  if (![self ensurePipelinesForDevice:device pass:pass]) return;
  [self uploadIfNeeded:data device:device];
  if (_vertices == nil || _indices == nil) return;

  id<MTLTexture> target = pass.colorAttachments[0].texture;
  const double widthPx = target.width, heightPx = target.height;
  const double scale = context.size.width > 0 ? widthPx / context.size.width : 1.0;

  LayerUniforms u{};
  const std::array<float, 16> mvp =
      maprama::buildingLayerMatrix(matrixArray(context.nearClippedProjectionMatrix), context.zoomLevel, *data);
  std::copy(mvp.begin(), mvp.end(), u.mvp);
  u.lightPos[0] = data->light.position[0];
  u.lightPos[1] = data->light.position[1];
  u.lightPos[2] = data->light.position[2];
  u.lightPos[3] = data->light.intensity;
  u.lightColor[0] = data->light.color[0];
  u.lightColor[1] = data->light.color[1];
  u.lightColor[2] = data->light.color[2];
  u.lightColor[3] = data->windowLights;
  u.viewport[0] = static_cast<float>(widthPx);
  u.viewport[1] = static_cast<float>(heightPx);
  u.viewport[2] = static_cast<float>(data->lineWidth * scale * 0.5);

  [encoder pushDebugGroup:@"maprama-buildings-3d"];
  [encoder setCullMode:MTLCullModeNone];
  // Same projection as the fill-extrusion walls (MapLibre's near-clipped matrix, full depth range on Metal):
  // the depth test against them is exact. A small bias lets the facade quads win over the walls they cover.
  [encoder setRenderPipelineState:_meshPipeline];
  [encoder setDepthStencilState:_meshDepth];
  [encoder setDepthBias:-2.0f slopeScale:-1.0f clamp:0.0f];
  [encoder setVertexBuffer:_vertices offset:0 atIndex:0];
  [encoder setVertexBytes:&u length:sizeof u atIndex:1];
  [encoder setFragmentBytes:&u length:sizeof u atIndex:1];
  [encoder drawIndexedPrimitives:MTLPrimitiveTypeTriangle
                      indexCount:_indexCount
                       indexType:MTLIndexTypeUInt32
                     indexBuffer:_indices
               indexBufferOffset:0];
  if (_lineIndexCount > 0 && _lineVertices != nil && data->lineWidth > 0) {
    [encoder setRenderPipelineState:_linePipeline];
    [encoder setDepthStencilState:_lineDepth];
    [encoder setDepthBias:-8.0f slopeScale:-2.0f clamp:0.0f];
    [encoder setVertexBuffer:_lineVertices offset:0 atIndex:0];
    [encoder setVertexBytes:&u length:sizeof u atIndex:1];
    [encoder drawIndexedPrimitives:MTLPrimitiveTypeTriangle
                        indexCount:_lineIndexCount
                         indexType:MTLIndexTypeUInt32
                       indexBuffer:_lineIndices
                 indexBufferOffset:0];
  }
  // MapLibre does not track the depth bias: leave it as it found it for the extrusions drawn next.
  [encoder setDepthBias:0.0f slopeScale:0.0f clamp:0.0f];
  [encoder popDebugGroup];

  [self recordFrameStart:start commandBuffer:self.commandBuffer];
}

- (void)recordFrameStart:(CFTimeInterval)start commandBuffer:(id<MTLCommandBuffer>)commandBuffer {
  const CFTimeInterval now = CACurrentMediaTime();
  _encodeMs.push_back((now - start) * 1000.0);
  if (_lastDraw > 0) _intervals.push_back((start - _lastDraw) * 1000.0);
  _lastDraw = start;
  if (commandBuffer != nil) {
    auto gpu = _gpuMs;
    auto gpuMutex = _gpuMutex;
    [commandBuffer addCompletedHandler:^(id<MTLCommandBuffer> buffer) {
      const double ms = (buffer.GPUEndTime - buffer.GPUStartTime) * 1000.0;
      if (ms > 0) {
        std::lock_guard<std::mutex> lock(*gpuMutex);
        gpu->push_back(ms);
      }
    }];
  }
  if (static_cast<int>(_encodeMs.size()) < kStatsFrames) return;
  const auto stats = [](std::vector<double> v, double *avg, double *p95) {
    if (v.empty()) {
      *avg = 0;
      *p95 = 0;
      return;
    }
    double sum = 0;
    for (double x : v) sum += x;
    *avg = sum / v.size();
    std::sort(v.begin(), v.end());
    *p95 = v[std::min(v.size() - 1, static_cast<size_t>(v.size() * 0.95))];
  };
  // Intervals longer than 100 ms are idle gaps (MapLibre renders on demand), not frames.
  std::vector<double> busy;
  for (double x : _intervals) {
    if (x < 100) busy.push_back(x);
  }
  std::vector<double> gpu;
  {
    std::lock_guard<std::mutex> lock(*_gpuMutex);
    gpu.swap(*_gpuMs);
  }
  double intervalAvg, intervalP95, encodeAvg, encodeP95, gpuAvg, gpuP95;
  stats(busy, &intervalAvg, &intervalP95);
  stats(_encodeMs, &encodeAvg, &encodeP95);
  stats(gpu, &gpuAvg, &gpuP95);
  os_log(layerLog(),
         "maprama-frame-stats frames=%d interval_avg=%.2fms interval_p95=%.2fms frame_gpu_avg=%.2fms frame_gpu_p95=%.2fms "
         "layer_encode_avg=%.3fms layer_encode_p95=%.3fms",
         static_cast<int>(_encodeMs.size()), intervalAvg, intervalP95, gpuAvg, gpuP95, encodeAvg, encodeP95);
  _encodeMs.clear();
  _intervals.clear();
}

@end
