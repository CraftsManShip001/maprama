#import "MapramaBuildingLayer.h"

#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#import <mach/mach.h>
#import <os/log.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <vector>

NSString *const MapramaBuildingLayerIdentifier = @"maprama-buildings-3d";

namespace {

os_log_t layerLog() {
  static os_log_t log = os_log_create("dev.maprama.engine", "building-layer");
  return log;
}

/// Uniforms shared by both pipelines (std140-compatible layout, 128 bytes).
struct LayerUniforms {
  float mvp[16];
  float lightPos[4];    // xyz, w = intensity
  float lightColor[4];  // rgb, w = window lights
  float viewport[4];    // width px, height px, line half-width px, 0
  float zoom[4];        // x = M4 building height scale, yzw = 0
};

/// Physical memory footprint of the process (DESIGN.md §8), in MB.
double processFootprintMB() {
  task_vm_info_data_t info{};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS) return 0;
  return static_cast<double>(info.phys_footprint) / 1048576.0;
}

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
  float4 zoom;  // x = building height scale (M4 `mapColors`)
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
  out.position = u.mvp * float4(in.position.xy, in.position.z * u.zoom.x, 1.0);
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
  float4 a = u.mvp * float4(in.position.xy, in.position.z * u.zoom.x, 1.0);
  const float4 b = u.mvp * float4(in.other.xy, in.other.z * u.zoom.x, 1.0);
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

/// M3b model pass uniforms (112 bytes, same layout as `ModelUniforms` in kModelShaderSource).
struct ModelUniforms {
  float mvp[16];
  float lightPos[4];    // xyz, w = intensity
  float lightColor[4];  // rgb
  float tint[4];        // time-of-day tint rgb
};

// M3b models: GPU linear-blend skinning (4 influences into the draw's palette), per-instance model matrices and
// colours, the building layer's extrusion lighting in the frame's local space (east, south, up), alpha cutoff /
// blended / additive parts with premultiplied output (MapLibre blends premultiplied). Same math as the GLSL
// shaders of the Android layer (maprama_building_layer.cpp).
NSString *const kModelShaderSource = @R"MSL(
#include <metal_stdlib>
using namespace metal;

struct ModelUniforms {
  float4x4 mvp;
  float4 lightPos;
  float4 lightColor;
  float4 tint;
};

struct ModelInstance {
  float4x4 matrix;
  float4 color;
};

struct ModelIn {
  float3 position [[attribute(0)]];
  float4 normal [[attribute(1)]];
  float2 uv [[attribute(2)]];
  float4 color [[attribute(3)]];
  uchar4 joints [[attribute(4)]];
  float4 weights [[attribute(5)]];
};

struct ModelOut {
  float4 position [[position]];
  float4 color;
  float3 normal;
  float2 uv;
  float unlit;
};

vertex ModelOut model_vertex(ModelIn in [[stage_in]], constant ModelUniforms& u [[buffer(1)]],
                             device const float4x4* palette [[buffer(2)]], device const ModelInstance* instances [[buffer(3)]],
                             uint iid [[instance_id]]) {
  const float4x4 skin = palette[in.joints.x] * in.weights.x + palette[in.joints.y] * in.weights.y +
                        palette[in.joints.z] * in.weights.z + palette[in.joints.w] * in.weights.w;
  const ModelInstance inst = instances[iid];
  const float4 local = inst.matrix * (skin * float4(in.position, 1.0));
  ModelOut out;
  out.position = u.mvp * local;
  const float3x3 m = float3x3(inst.matrix[0].xyz, inst.matrix[1].xyz, inst.matrix[2].xyz) *
                     float3x3(skin[0].xyz, skin[1].xyz, skin[2].xyz);
  out.normal = m * in.normal.xyz;
  out.color = in.color * inst.color;
  out.uv = in.uv;
  out.unlit = in.normal.w > 0.5 ? 1.0 : 0.0;
  return out;
}

static float3 extrusionLight(float3 color, float3 n, constant ModelUniforms& u) {
  const float colorvalue = dot(color, float3(0.2126, 0.7152, 0.0722));
  color += 0.03;
  const float intensity = u.lightPos.w;
  float directional = clamp(dot(n, u.lightPos.xyz), 0.0, 1.0);
  directional = mix(1.0 - intensity, max(1.0 - colorvalue + intensity, 1.0), directional);
  const float3 lc = u.lightColor.rgb;
  return clamp(color * directional * lc, mix(float3(0.0), float3(0.3), 1.0 - lc), float3(1.0));
}

// part: x = alpha cutoff (< 0: none), y = additive, z = blended.
fragment float4 model_fragment(ModelOut in [[stage_in]], constant ModelUniforms& u [[buffer(1)]], constant float4& part [[buffer(2)]],
                               texture2d<float> tex [[texture(0)]], sampler smp [[sampler(0)]]) {
  const float4 base = in.color * tex.sample(smp, in.uv);
  if (base.a < part.x) discard_fragment();
  const float3 color = base.rgb * u.tint.rgb;
  const float3 lit = in.unlit > 0.5 ? color : extrusionLight(color, normalize(in.normal), u);
  if (part.y > 0.5) return float4(lit * base.a, 0.0);
  if (part.z > 0.5) return float4(lit * base.a, base.a);
  return float4(lit, 1.0);
}
)MSL";

/// GPU copy of one `ModelMesh` (kept while frames use it).
struct GpuModelMesh {
  id<MTLBuffer> vertices;
  id<MTLBuffer> indices;
  std::vector<id<MTLTexture>> textures;
  std::uint64_t lastUsed = 0;
};

/// Meshes unused for this many drawn frames are released.
constexpr std::uint64_t kMeshKeepFrames = 600;

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
  std::shared_ptr<const maprama::ModelLayerFrame> _modelFrame;
  maprama::BuildingLayerZoom _zoom;

  // M3b model pass.
  id<MTLRenderPipelineState> _modelPipeline;
  id<MTLRenderPipelineState> _modelBlendPipeline;
  id<MTLDepthStencilState> _modelBlendDepth;
  id<MTLSamplerState> _sampler;
  id<MTLTexture> _whiteTexture;
  std::unordered_map<std::uint64_t, GpuModelMesh> _meshes;
  id<MTLBuffer> _paletteRing[3];
  id<MTLBuffer> _instanceRing[3];
  NSUInteger _ring;
  std::uint64_t _modelFrames;
  std::vector<double> _modelEncodeMs;
  std::size_t _lastModelDraws;
  std::size_t _lastModels;
  std::uint64_t _lastModelVersion;

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
  /// M4: the low-detail index range (no facade details / roof furniture).
  id<MTLBuffer> _lowIndices;
  id<MTLBuffer> _lineVertices;
  id<MTLBuffer> _lineIndices;
  NSUInteger _indexCount;
  NSUInteger _lowIndexCount;
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

- (void)setModelFrame:(std::shared_ptr<const maprama::ModelLayerFrame>)frame {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    _modelFrame = std::move(frame);
  }
  [self setNeedsDisplay];
}

- (void)setZoom:(maprama::BuildingLayerZoom)zoom {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    _zoom = zoom;
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
  _lowIndices = nil;
  _lineVertices = nil;
  _lineIndices = nil;
  _uploadedVersion = 0;
  _modelPipeline = nil;
  _modelBlendPipeline = nil;
  _modelBlendDepth = nil;
  _sampler = nil;
  _whiteTexture = nil;
  _meshes.clear();
  for (int i = 0; i < 3; ++i) {
    _paletteRing[i] = nil;
    _instanceRing[i] = nil;
  }
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
  [self ensureModelPipelinesForDevice:device color:color depth:depth stencil:stencil samples:samples];
  return !_pipelineFailed;
}

/// M3b: the skinned model pipelines (opaque + premultiplied blend), sampler and the 1x1 white texture. A failure
/// only disables the models.
- (void)ensureModelPipelinesForDevice:(id<MTLDevice>)device
                                color:(MTLPixelFormat)color
                                depth:(MTLPixelFormat)depth
                              stencil:(MTLPixelFormat)stencil
                              samples:(NSUInteger)samples {
  _modelPipeline = nil;
  _modelBlendPipeline = nil;
  NSError *error = nil;
  id<MTLLibrary> library = [device newLibraryWithSource:kModelShaderSource options:nil error:&error];
  if (library == nil) {
    os_log_error(layerLog(), "model shader compile failed: %{public}@", error.localizedDescription);
    return;
  }
  MTLVertexDescriptor *layout = [MTLVertexDescriptor vertexDescriptor];
  const struct {
    MTLVertexFormat format;
    NSUInteger offset;
  } attrs[] = {
      {MTLVertexFormatFloat3, offsetof(maprama::ModelVertex, position)},
      {MTLVertexFormatChar4Normalized, offsetof(maprama::ModelVertex, normal)},
      {MTLVertexFormatFloat2, offsetof(maprama::ModelVertex, uv)},
      {MTLVertexFormatUChar4Normalized, offsetof(maprama::ModelVertex, color)},
      {MTLVertexFormatUChar4, offsetof(maprama::ModelVertex, joints)},
      {MTLVertexFormatUChar4Normalized, offsetof(maprama::ModelVertex, weights)},
  };
  for (NSUInteger i = 0; i < sizeof attrs / sizeof attrs[0]; ++i) {
    layout.attributes[i].format = attrs[i].format;
    layout.attributes[i].offset = attrs[i].offset;
    layout.attributes[i].bufferIndex = 0;
  }
  layout.layouts[0].stride = sizeof(maprama::ModelVertex);
  const auto makePipeline = [&](BOOL blend) -> id<MTLRenderPipelineState> {
    MTLRenderPipelineDescriptor *desc = [[MTLRenderPipelineDescriptor alloc] init];
    desc.vertexFunction = [library newFunctionWithName:@"model_vertex"];
    desc.fragmentFunction = [library newFunctionWithName:@"model_fragment"];
    desc.vertexDescriptor = layout;
    desc.colorAttachments[0].pixelFormat = color;
    if (blend) {
      desc.colorAttachments[0].blendingEnabled = YES;
      desc.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorOne;
      desc.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
      desc.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
      desc.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    }
    desc.depthAttachmentPixelFormat = depth;
    desc.stencilAttachmentPixelFormat = stencil;
    desc.rasterSampleCount = samples;
    NSError *pipelineError = nil;
    id<MTLRenderPipelineState> state = [device newRenderPipelineStateWithDescriptor:desc error:&pipelineError];
    if (state == nil) os_log_error(layerLog(), "model pipeline failed: %{public}@", pipelineError.localizedDescription);
    return state;
  };
  _modelPipeline = makePipeline(NO);
  _modelBlendPipeline = makePipeline(YES);
  MTLDepthStencilDescriptor *depthDesc = [[MTLDepthStencilDescriptor alloc] init];
  depthDesc.depthCompareFunction = MTLCompareFunctionLessEqual;
  depthDesc.depthWriteEnabled = NO;
  _modelBlendDepth = [device newDepthStencilStateWithDescriptor:depthDesc];
  MTLSamplerDescriptor *samplerDesc = [[MTLSamplerDescriptor alloc] init];
  samplerDesc.minFilter = MTLSamplerMinMagFilterLinear;
  samplerDesc.magFilter = MTLSamplerMinMagFilterLinear;
  samplerDesc.sAddressMode = MTLSamplerAddressModeRepeat;
  samplerDesc.tAddressMode = MTLSamplerAddressModeRepeat;
  _sampler = [device newSamplerStateWithDescriptor:samplerDesc];
  MTLTextureDescriptor *white = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:1 height:1 mipmapped:NO];
  _whiteTexture = [device newTextureWithDescriptor:white];
  const std::uint8_t pixel[4] = {255, 255, 255, 255};
  [_whiteTexture replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:pixel bytesPerRow:4];
  _meshes.clear();
  if (_modelPipeline != nil && _modelBlendPipeline != nil) os_log_info(layerLog(), "model pipelines ready");
}

- (GpuModelMesh *)gpuMesh:(const maprama::ModelMesh &)mesh device:(id<MTLDevice>)device {
  auto it = _meshes.find(mesh.id);
  if (it == _meshes.end()) {
    if (mesh.vertices.empty() || mesh.indices.empty()) return nullptr;
    GpuModelMesh gpu;
    gpu.vertices = [device newBufferWithBytes:mesh.vertices.data() length:mesh.vertices.size() * sizeof(maprama::ModelVertex)
                                      options:MTLResourceStorageModeShared];
    gpu.indices = [device newBufferWithBytes:mesh.indices.data() length:mesh.indices.size() * sizeof(std::uint32_t)
                                     options:MTLResourceStorageModeShared];
    for (const maprama::ModelTexture &t : mesh.textures) {
      MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                                                      width:static_cast<NSUInteger>(t.width)
                                                                                     height:static_cast<NSUInteger>(t.height)
                                                                                  mipmapped:NO];
      id<MTLTexture> texture = [device newTextureWithDescriptor:desc];
      [texture replaceRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(t.width), static_cast<NSUInteger>(t.height))
                 mipmapLevel:0
                   withBytes:t.rgba.data()
                 bytesPerRow:static_cast<NSUInteger>(t.width) * 4];
      gpu.textures.push_back(texture);
    }
    os_log_info(layerLog(), "model mesh %llu uploaded: %lu vertices, %lu triangles, %lu textures (%{public}s)", mesh.id,
                (unsigned long)mesh.vertices.size(), (unsigned long)(mesh.indices.size() / 3), (unsigned long)mesh.textures.size(),
                mesh.name.c_str());
    it = _meshes.emplace(mesh.id, std::move(gpu)).first;
  }
  it->second.lastUsed = _modelFrames;
  return &it->second;
}

/// A shared per-frame buffer of the ring (three frames in flight), grown as needed.
- (id<MTLBuffer>)ringBuffer:(id<MTLBuffer> __strong *)ring length:(NSUInteger)length device:(id<MTLDevice>)device {
  id<MTLBuffer> buffer = ring[_ring];
  if (buffer == nil || buffer.length < length) {
    buffer = [device newBufferWithLength:std::max<NSUInteger>(length + length / 2, 4096) options:MTLResourceStorageModeShared];
    ring[_ring] = buffer;
  }
  return buffer;
}

- (void)drawModels:(const maprama::ModelLayerFrame &)frame
           encoder:(id<MTLRenderCommandEncoder>)encoder
           context:(MLNStyleLayerDrawingContext)context
            device:(id<MTLDevice>)device {
  if (_modelPipeline == nil || _modelBlendPipeline == nil || frame.draws.empty() || frame.instances.empty()) return;
  const CFTimeInterval start = CACurrentMediaTime();
  ++_modelFrames;
  _ring = (_ring + 1) % 3;
  const NSUInteger paletteBytes = frame.palettes.size() * sizeof(float);
  const NSUInteger instanceBytes = frame.instances.size() * sizeof(maprama::ModelInstance);
  id<MTLBuffer> palettes = [self ringBuffer:_paletteRing length:paletteBytes device:device];
  id<MTLBuffer> instances = [self ringBuffer:_instanceRing length:instanceBytes device:device];
  std::memcpy(palettes.contents, frame.palettes.data(), paletteBytes);
  std::memcpy(instances.contents, frame.instances.data(), instanceBytes);

  ModelUniforms u{};
  const std::array<float, 16> mvp = maprama::modelLayerMatrix(matrixArray(context.nearClippedProjectionMatrix), context.zoomLevel,
                                                              frame.originX, frame.originY, frame.unitsPerMercator);
  std::copy(mvp.begin(), mvp.end(), u.mvp);
  u.lightPos[0] = frame.light.position[0];
  u.lightPos[1] = frame.light.position[1];
  u.lightPos[2] = frame.light.position[2];
  u.lightPos[3] = frame.light.intensity;
  u.lightColor[0] = frame.light.color[0];
  u.lightColor[1] = frame.light.color[1];
  u.lightColor[2] = frame.light.color[2];
  u.tint[0] = frame.tint[0];
  u.tint[1] = frame.tint[1];
  u.tint[2] = frame.tint[2];

  [encoder pushDebugGroup:@"maprama-models"];
  [encoder setCullMode:MTLCullModeNone];
  [encoder setDepthBias:0.0f slopeScale:0.0f clamp:0.0f];
  [encoder setVertexBytes:&u length:sizeof u atIndex:1];
  [encoder setFragmentBytes:&u length:sizeof u atIndex:1];
  [encoder setVertexBuffer:instances offset:0 atIndex:3];
  [encoder setFragmentSamplerState:_sampler atIndex:0];
  std::size_t draws = 0;
  for (int pass = 0; pass < 2; ++pass) {
    const bool translucent = pass == 1;
    [encoder setRenderPipelineState:translucent ? _modelBlendPipeline : _modelPipeline];
    [encoder setDepthStencilState:translucent ? _modelBlendDepth : _meshDepth];
    for (const maprama::ModelDraw &d : frame.draws) {
      if (!d.mesh || d.instanceCount == 0) continue;
      const bool any = std::any_of(d.mesh->parts.begin(), d.mesh->parts.end(),
                                   [&](const maprama::ModelPart &p) { return p.translucent() == translucent; });
      if (!any) continue;
      GpuModelMesh *gpu = [self gpuMesh:*d.mesh device:device];
      if (gpu == nullptr) continue;
      [encoder setVertexBuffer:gpu->vertices offset:0 atIndex:0];
      [encoder setVertexBuffer:palettes offset:static_cast<NSUInteger>(d.palette) * 16 * sizeof(float) atIndex:2];
      for (const maprama::ModelPart &part : d.mesh->parts) {
        if (part.translucent() != translucent || part.indexCount == 0) continue;
        const bool textured = part.texture >= 0 && static_cast<std::size_t>(part.texture) < gpu->textures.size();
        [encoder setFragmentTexture:textured ? gpu->textures[static_cast<std::size_t>(part.texture)] : _whiteTexture atIndex:0];
        const float info[4] = {part.alpha == maprama::ModelAlpha::Mask ? part.alphaCutoff : -1.0f, part.additive ? 1.0f : 0.0f,
                               part.alpha == maprama::ModelAlpha::Blend ? 1.0f : 0.0f, 0.0f};
        [encoder setFragmentBytes:info length:sizeof info atIndex:2];
        [encoder drawIndexedPrimitives:MTLPrimitiveTypeTriangle
                            indexCount:part.indexCount
                             indexType:MTLIndexTypeUInt32
                           indexBuffer:gpu->indices
                     indexBufferOffset:static_cast<NSUInteger>(part.firstIndex) * sizeof(std::uint32_t)
                         instanceCount:d.instanceCount
                            baseVertex:0
                          baseInstance:d.firstInstance];
        ++draws;
      }
    }
  }
  [encoder popDebugGroup];
  // Release meshes no frame used for a while (a removed character's model, a replaced procedural body).
  for (auto it = _meshes.begin(); it != _meshes.end();) {
    it = _modelFrames - it->second.lastUsed > kMeshKeepFrames ? _meshes.erase(it) : std::next(it);
  }
  _lastModelDraws = draws;
  _lastModels = frame.characters + frame.drops;
  _modelEncodeMs.push_back((CACurrentMediaTime() - start) * 1000.0);
}

- (void)uploadIfNeeded:(const std::shared_ptr<const maprama::BuildingLayerData> &)data device:(id<MTLDevice>)device {
  if (!data || data->version == _uploadedVersion) return;
  const auto buffer = [&](const void *bytes, NSUInteger length) -> id<MTLBuffer> {
    return length > 0 ? [device newBufferWithBytes:bytes length:length options:MTLResourceStorageModeShared] : nil;
  };
  _vertices = buffer(data->vertices.data(), data->vertices.size() * sizeof(maprama::BuildingMeshVertex));
  _indices = buffer(data->indices.data(), data->indices.size() * sizeof(std::uint32_t));
  _lowIndices = buffer(data->lowDetailIndices.data(), data->lowDetailIndices.size() * sizeof(std::uint32_t));
  _lineVertices = buffer(data->lineVertices.data(), data->lineVertices.size() * sizeof(maprama::BuildingLineVertex));
  _lineIndices = buffer(data->lineIndices.data(), data->lineIndices.size() * sizeof(std::uint32_t));
  _indexCount = data->indices.size();
  _lowIndexCount = data->lowDetailIndices.size();
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
  std::shared_ptr<const maprama::ModelLayerFrame> models;
  maprama::BuildingLayerZoom zoom;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_pending) _drawn = _pending;
    data = _drawn;
    models = _modelFrame;
    zoom = _zoom;
  }
  const bool haveBuildings = data && !data->indices.empty();
  const bool haveModels = models && !models->draws.empty();
  if (!haveBuildings && !haveModels) return;
  id<MTLDevice> device = encoder.device;
  if (![self ensurePipelinesForDevice:device pass:pass]) return;
  if (!haveBuildings) {
    [self drawModels:*models encoder:encoder context:context device:device];
    [encoder setDepthBias:0.0f slopeScale:0.0f clamp:0.0f];
    [self recordFrameStart:start commandBuffer:self.commandBuffer];
    return;
  }
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
  u.zoom[0] = zoom.heightScale;

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
  // M4 zoom-out: beyond engine-web's clutter threshold the low-detail range (roofs, facades, outlines) is drawn.
  const BOOL low = zoom.lowDetail && _lowIndices != nil && _lowIndexCount > 0;
  [encoder drawIndexedPrimitives:MTLPrimitiveTypeTriangle
                      indexCount:low ? _lowIndexCount : _indexCount
                       indexType:MTLIndexTypeUInt32
                     indexBuffer:low ? _lowIndices : _indices
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
  [encoder popDebugGroup];
  // M3b: the models, in the same pass and depth range (occluded by and occluding the walls / roofs).
  if (haveModels) [self drawModels:*models encoder:encoder context:context device:device];
  // MapLibre does not track the depth bias: leave it as it found it for the extrusions drawn next.
  [encoder setDepthBias:0.0f slopeScale:0.0f clamp:0.0f];

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
  double intervalAvg, intervalP95, encodeAvg, encodeP95, gpuAvg, gpuP95, modelAvg, modelP95;
  stats(busy, &intervalAvg, &intervalP95);
  stats(_encodeMs, &encodeAvg, &encodeP95);
  stats(gpu, &gpuAvg, &gpuP95);
  stats(_modelEncodeMs, &modelAvg, &modelP95);
  maprama::BuildingLayerZoom zoom;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    zoom = _zoom;
  }
  const double metalMB = _device != nil ? static_cast<double>(_device.currentAllocatedSize) / 1048576.0 : 0.0;
  os_log(layerLog(),
         "maprama-frame-stats frames=%d interval_avg=%.2fms interval_p95=%.2fms frame_gpu_avg=%.2fms frame_gpu_p95=%.2fms "
         "layer_encode_avg=%.3fms layer_encode_p95=%.3fms models=%lu model_draws=%lu model_encode_avg=%.3fms model_encode_p95=%.3fms "
         "metal_mb=%.1f footprint_mb=%.1f low_detail=%d height_scale=%.2f",
         static_cast<int>(_encodeMs.size()), intervalAvg, intervalP95, gpuAvg, gpuP95, encodeAvg, encodeP95, (unsigned long)_lastModels,
         (unsigned long)_lastModelDraws, modelAvg, modelP95, metalMB, processFootprintMB(), zoom.lowDetail ? 1 : 0,
         static_cast<double>(zoom.heightScale));
  _encodeMs.clear();
  _intervals.clear();
  _modelEncodeMs.clear();
}

@end
