#import "MapramaLabelLayer.h"

#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>
#include <string>
#include <unordered_map>

#include "maprama/LabelIcons.hpp"

using maprama::LabelCard;
using maprama::LabelCardContent;
using maprama::LabelFrame;
using maprama::LabelKind;
using maprama::LabelTile;
using maprama::LabelVisual;

namespace {

UIColor *rgba(std::uint32_t rgb, CGFloat alpha = 1.0) {
  return [UIColor colorWithRed:((rgb >> 16) & 0xFF) / 255.0 green:((rgb >> 8) & 0xFF) / 255.0 blue:(rgb & 0xFF) / 255.0 alpha:alpha];
}

NSString *ns(const std::string &s) {
  NSString *out = [[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding];
  return out ?: @"";
}

UIFont *labelFont(CGFloat size, UIFontWeight weight, BOOL italic = NO, BOOL rounded = NO) {
  UIFont *font = [UIFont systemFontOfSize:size weight:weight];
  UIFontDescriptor *d = font.fontDescriptor;
  if (rounded) {
    if (UIFontDescriptor *r = [d fontDescriptorWithDesign:UIFontDescriptorSystemDesignRounded]) d = r;
  }
  if (italic) {
    if (UIFontDescriptor *i = [d fontDescriptorWithSymbolicTraits:d.symbolicTraits | UIFontDescriptorTraitItalic]) d = i;
  }
  return d == font.fontDescriptor ? font : [UIFont fontWithDescriptor:d size:size];
}

NSAttributedString *styled(NSString *text, UIFont *font, UIColor *color, CGFloat kernEm) {
  return [[NSAttributedString alloc] initWithString:text
                                         attributes:@{
                                           NSFontAttributeName : font,
                                           NSForegroundColorAttributeName : color,
                                           NSKernAttributeName : @(kernEm * font.pointSize),
                                         }];
}

UIColor *paintColor(maprama::IconPaint paint, UIColor *current, UIColor *accent, CGFloat opacity) {
  UIColor *c = nil;
  switch (paint) {
    case maprama::IconPaint::None:
      return nil;
    case maprama::IconPaint::Current:
      c = current;
      break;
    case maprama::IconPaint::Accent:
      c = accent;
      break;
    case maprama::IconPaint::White:
      c = UIColor.whiteColor;
      break;
  }
  if (opacity >= 1.0) return c;
  CGFloat alpha = 1;
  [c getRed:nil green:nil blue:nil alpha:&alpha];
  return [c colorWithAlphaComponent:alpha * opacity];
}

/// Replays a generated icon drawing into `host` (sublayers replaced), fitted into `rect`.
void drawIcon(CALayer *host, const maprama::IconDrawing *drawing, CGRect rect, UIColor *current, UIColor *accent) {
  for (CALayer *l in [host.sublayers copy]) [l removeFromSuperlayer];
  if (drawing == nullptr) return;
  const CGFloat scale = UIScreen.mainScreen.scale;
  if (drawing->text != nullptr) {
    CATextLayer *t = [CATextLayer layer];
    t.string = [NSString stringWithUTF8String:drawing->text];
    UIFont *font = labelFont(std::max<CGFloat>(8, rect.size.height * 0.8), UIFontWeightBold);
    t.font = (__bridge CFTypeRef)font;
    t.fontSize = font.pointSize;
    t.foregroundColor = UIColor.whiteColor.CGColor;
    t.alignmentMode = kCAAlignmentCenter;
    t.contentsScale = scale;
    t.frame = CGRectMake(rect.origin.x, rect.origin.y + (rect.size.height - font.lineHeight) / 2, rect.size.width, font.lineHeight);
    [host addSublayer:t];
    return;
  }
  const CGFloat s = rect.size.width / drawing->size;
  for (std::size_t i = 0; i < drawing->shapeCount; ++i) {
    const maprama::IconShape &shape = drawing->shapes[i];
    CGMutablePathRef path = CGPathCreateMutable();
    const float *c = shape.coords;
    const auto X = [&](float v) { return rect.origin.x + v * s; };
    const auto Y = [&](float v) { return rect.origin.y + v * s; };
    for (const char *op = shape.ops; *op != '\0'; ++op) {
      switch (*op) {
        case 'M':
          CGPathMoveToPoint(path, nullptr, X(c[0]), Y(c[1]));
          c += 2;
          break;
        case 'L':
          CGPathAddLineToPoint(path, nullptr, X(c[0]), Y(c[1]));
          c += 2;
          break;
        case 'C':
          CGPathAddCurveToPoint(path, nullptr, X(c[0]), Y(c[1]), X(c[2]), Y(c[3]), X(c[4]), Y(c[5]));
          c += 6;
          break;
        default:
          CGPathCloseSubpath(path);
          break;
      }
    }
    CAShapeLayer *l = [CAShapeLayer layer];
    l.path = path;
    CGPathRelease(path);
    l.contentsScale = scale;
    UIColor *fill = paintColor(shape.fill, current, accent, shape.fillOpacity);
    UIColor *stroke = paintColor(shape.stroke, current, accent, 1.0);
    l.fillColor = fill.CGColor;
    l.strokeColor = stroke.CGColor;
    l.lineWidth = stroke != nil ? shape.strokeWidth * s : 0;
    l.lineCap = drawing->roundCaps ? kCALineCapRound : kCALineCapButt;
    l.lineJoin = drawing->roundCaps ? kCALineJoinRound : kCALineJoinMiter;
    [host addSublayer:l];
  }
}

/// engine-web text colours / fonts per app-style label (dom-styles.ts `.mpr-ml*`, `.ls-*`, `.night`).
struct AppLook {
  UIFont *font = nil;
  UIColor *color = nil;
  CGFloat kern = 0;
  /// Text halo (CSS text-shadow); nil = none.
  UIColor *halo = nil;
  CGFloat haloRadius = 0;
  /// Pill background (sticker, clean arterial roads); nil = none.
  UIColor *background = nil;
  UIColor *border = nil;
  CGFloat borderWidth = 0;
  CGFloat radius = 0;
  UIEdgeInsets padding = UIEdgeInsetsZero;
  BOOL hardShadow = NO;  // sticker: 0 2px 0 #2A2540
  BOOL softShadow = NO;  // clean arterial pill
  // POI badge
  CGFloat badge = 18, glyph = 12, gap = 4, ring = 1.5;
  BOOL badgeShadow = NO;
};

AppLook appLook(LabelVisual visual, const LabelCardContent &c, bool night) {
  AppLook k;
  const bool district = c.kind == LabelKind::District && !c.water, water = c.kind == LabelKind::District && c.water;
  const bool road = c.kind == LabelKind::Road, poi = c.kind == LabelKind::Poi, art = road && c.arterial;
  switch (visual) {
    case LabelVisual::Minimal: {
      k.halo = UIColor.whiteColor;
      k.haloRadius = 2.5;
      k.color = rgba(0x3A404B);
      if (district) k = (k.font = labelFont(12.5, UIFontWeightSemibold), k.kern = 0.5, k.color = rgba(0x454B57), k);
      else if (water) k = (k.font = labelFont(12, UIFontWeightMedium, YES), k.kern = 0.4, k);
      else if (road) k = (k.font = labelFont(10.5, art ? UIFontWeightSemibold : UIFontWeightMedium), k.color = rgba(art ? 0x6E4F1A : 0x4A505B), k);
      else k = (k.font = labelFont(10.5, UIFontWeightMedium), k.badge = 12, k.glyph = 8, k.gap = 3, k.ring = 1, k);
      break;
    }
    case LabelVisual::Sticker: {
      k.color = rgba(0x2A2540);
      k.background = UIColor.whiteColor;
      k.border = rgba(0x2A2540);
      k.borderWidth = 1.5;
      k.hardShadow = YES;
      k.padding = UIEdgeInsetsMake(3, 9, 2, 9);
      if (district) {
        k.font = labelFont(14, UIFontWeightSemibold, NO, YES);
        k.background = rgba(0x2A2540);
        k.color = UIColor.whiteColor;
        k.padding = UIEdgeInsetsMake(4, 12, 3, 12);
        k.kern = 0.28;
      } else if (water) {
        k.font = labelFont(13, UIFontWeightMedium, NO, YES);
        k.background = rgba(0xDDEFFB);
        k.color = rgba(0x1F5E8C);
        k.kern = 0.32;
      } else if (road) {
        k.font = labelFont(11.5, UIFontWeightRegular, NO, YES);
        if (art) k.background = rgba(0xFFE7A8);
      } else {
        k.font = labelFont(11.5, UIFontWeightRegular, NO, YES);
        k.padding = UIEdgeInsetsMake(2, 2, 2, 9);
      }
      break;
    }
    case LabelVisual::Clean: {
      k.halo = night ? rgba(0x0B1020) : UIColor.whiteColor;
      k.haloRadius = night ? 3.5 : 2.5;
      k.color = night ? rgba(0xEEF2F8) : rgba(0x2B313C);
      if (district) k = (k.font = labelFont(13, UIFontWeightBold), k.kern = 0.42, k.color = night ? k.color : rgba(0x343A46), k);
      else if (water) k = (k.font = labelFont(12, UIFontWeightSemibold), k.kern = 0.42, k.color = night ? k.color : rgba(0x2A6C9C), k);
      else if (road) {
        k.font = labelFont(12, UIFontWeightBold);
        k.kern = 0.02;
        k.color = night ? k.color : rgba(0x2F3540);
        if (art) {
          k.color = night ? rgba(0xF3F5FA) : rgba(0x252B35);
          k.halo = nil;
          k.background = night ? rgba(0x141A28, 0.72) : rgba(0xFFFFFF, 0.8);
          k.border = night ? rgba(0xFFFFFF, 0.18) : rgba(0xFFFFFF, 0.95);
          k.borderWidth = 1;
          k.radius = 6;
          k.padding = UIEdgeInsetsMake(2, 8, 2, 8);
          k.softShadow = YES;
        }
      } else {
        k = (k.font = labelFont(11, UIFontWeightSemibold), k.badge = 15, k.glyph = 9, k.gap = 5, k.badgeShadow = YES, k);
      }
      break;
    }
    case LabelVisual::App:
    case LabelVisual::Holo: {
      k.halo = night ? rgba(0x0B1020) : UIColor.whiteColor;
      k.haloRadius = night ? 3.5 : 2.5;
      k.color = night ? rgba(0xE8ECF5) : rgba(0x2F3440);
      if (district) k = (k.font = labelFont(15, UIFontWeightSemibold), k.kern = 0.28, k.color = night ? rgba(0xC9D2E6) : rgba(0x474C58), k);
      else if (water) k = (k.font = labelFont(13, UIFontWeightMedium, YES), k.kern = 0.32, k.color = night ? k.color : rgba(0x2F6F9E), k);
      else if (road) {
        k.font = labelFont(11, art ? UIFontWeightSemibold : UIFontWeightMedium);
        k.color = art ? (night ? rgba(0xF3D08A) : rgba(0x6A4712)) : (night ? k.color : rgba(0x565C67));
      } else {
        k.font = labelFont(11.5, UIFontWeightSemibold);
      }
      break;
    }
  }
  if (k.background != nil && k.radius == 0) k.radius = 999;
  (void)poi;
  return k;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------
// One card view (holo glass card or app-style label). Laid out manually; `configure…` returns its size.
// ---------------------------------------------------------------------------------------------------------

@interface MapramaLabelCardView : UIView
- (CGSize)configure:(const LabelCardContent &)content tile:(LabelTile)tile night:(BOOL)night;
@end

@implementation MapramaLabelCardView {
  UIView *_body;               // clipped rounded content (holo glass / app pill)
  UIVisualEffectView *_blur;   // holo backdrop blur
  CAGradientLayer *_gradient;  // holo glass tint
  CAGradientLayer *_accent;    // holo top accent line
  CALayer *_innerRing;         // holo inset ring
  UIView *_tile;               // holo icon tile / app POI badge
  CAGradientLayer *_tileGradient;
  CALayer *_iconHost;
  UILabel *_title;
  UILabel *_subtitle;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.userInteractionEnabled = NO;
    self.isAccessibilityElement = YES;
    self.accessibilityTraits = UIAccessibilityTraitStaticText;
    _body = [[UIView alloc] init];
    _body.clipsToBounds = YES;
    _body.userInteractionEnabled = NO;
    [self addSubview:_body];
    _blur = [[UIVisualEffectView alloc] initWithEffect:nil];
    [_body addSubview:_blur];
    _gradient = [CAGradientLayer layer];
    _gradient.startPoint = CGPointMake(0, 0);
    _gradient.endPoint = CGPointMake(1, 1);
    [_body.layer addSublayer:_gradient];
    _innerRing = [CALayer layer];
    _innerRing.borderWidth = 1;
    [_body.layer addSublayer:_innerRing];
    _accent = [CAGradientLayer layer];
    _accent.startPoint = CGPointMake(0, 0.5);
    _accent.endPoint = CGPointMake(1, 0.5);
    _accent.colors = @[ (id)rgba(0x6FB7FF, 0).CGColor, (id)rgba(0x6FB7FF).CGColor, (id)rgba(0x6FB7FF, 0).CGColor ];
    _accent.cornerRadius = 1;
    [self.layer addSublayer:_accent];
    _tile = [[UIView alloc] init];
    _tile.userInteractionEnabled = NO;
    _tileGradient = [CAGradientLayer layer];
    _tileGradient.startPoint = CGPointMake(0.25, 0);
    _tileGradient.endPoint = CGPointMake(0.75, 1);
    [_tile.layer addSublayer:_tileGradient];
    _iconHost = [CALayer layer];
    [_tile.layer addSublayer:_iconHost];
    [self addSubview:_tile];
    _title = [[UILabel alloc] init];
    _subtitle = [[UILabel alloc] init];
    for (UILabel *l in @[ _title, _subtitle ]) {
      l.numberOfLines = 1;
      l.isAccessibilityElement = NO;
      l.layer.shadowOffset = CGSizeZero;
      [self addSubview:l];
    }
  }
  return self;
}

- (CGSize)configure:(const LabelCardContent &)c tile:(LabelTile)tile night:(BOOL)night {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  self.accessibilityLabel = ns(c.accessibilityLabel);
  const CGSize size = c.visual == LabelVisual::Holo      ? [self configureHolo:c tile:tile night:night]
                      : c.visual == LabelVisual::NameTag ? [self configureTag:c]
                                                         : [self configureApp:c night:night];
  self.bounds = CGRectMake(0, 0, size.width, size.height);
  [CATransaction commit];
  return size;
}

- (CGSize)configureHolo:(const LabelCardContent &)c tile:(LabelTile)tile night:(BOOL)night {
  const bool district = c.kind == LabelKind::District;
  // engine-web .mpr-hl-card: padding 5 11 5 5 (district 7 14 7 7, text only 6 12), gap 7, radius 11.
  UIEdgeInsets pad = c.showIcon ? (district ? UIEdgeInsetsMake(7, 7, 7, 14) : UIEdgeInsetsMake(5, 5, 5, 11)) : UIEdgeInsetsMake(6, 12, 6, 12);
  UIFont *titleFont = labelFont(district ? 14 : 12, UIFontWeightSemibold);
  UIFont *subFont = labelFont(c.custom ? 10 : 8.5, UIFontWeightSemibold);
  UIColor *titleColor = night ? rgba(0xEAF2FF) : rgba(0x1E2533);
  UIColor *subColor = c.custom ? (night ? rgba(0x8FC3FF) : rgba(0x2F6BFF)) : (night ? rgba(0x9FB6D6) : rgba(0x5C6B80));
  _title.attributedText = styled(ns(c.title), titleFont, titleColor, district ? 0.14 : 0);
  _subtitle.hidden = !c.showSubtitle;
  _subtitle.attributedText = styled(ns(c.subtitle), subFont, subColor, c.custom ? 0.01 : 0.08);
  _title.layer.shadowOpacity = 0;
  _subtitle.layer.shadowOpacity = 0;
  const CGSize t = [_title sizeThatFits:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)];
  const CGSize s = c.showSubtitle ? [_subtitle sizeThatFits:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)] : CGSizeZero;
  const CGFloat textW = std::ceil(std::max(t.width, s.width));
  const CGFloat textH = std::ceil(titleFont.pointSize * 1.18 + (c.showSubtitle ? subFont.pointSize * 1.18 : 0));
  const CGFloat icon = c.showIcon ? 24 : 0, gap = c.showIcon ? 7 : 0;
  const CGFloat w = pad.left + icon + gap + textW + pad.right;
  const CGFloat h = pad.top + std::max(icon, textH) + pad.bottom;

  _body.frame = CGRectMake(0, 0, w, h);
  _body.layer.cornerRadius = 11;
  _body.layer.borderWidth = 1;
  _body.layer.borderColor = (night ? rgba(0x8CBEFF, 0.45) : rgba(0xFFFFFF, 0.95)).CGColor;
  _body.backgroundColor = UIColor.clearColor;
  _blur.hidden = NO;
  _blur.effect = [UIBlurEffect effectWithStyle:night ? UIBlurEffectStyleSystemUltraThinMaterialDark : UIBlurEffectStyleSystemUltraThinMaterialLight];
  _blur.frame = _body.bounds;
  _gradient.hidden = NO;
  _gradient.frame = _body.bounds;
  _gradient.colors = night ? @[ (id)rgba(0x121A2E, 0.8).CGColor, (id)rgba(0x1A2A4E, 0.62).CGColor ]
                           : @[ (id)rgba(0xFFFFFF, 0.84).CGColor, (id)rgba(0xE6F1FF, 0.62).CGColor ];
  _innerRing.hidden = NO;
  _innerRing.frame = CGRectInset(_body.bounds, 1, 1);
  _innerRing.cornerRadius = 10;
  _innerRing.borderColor = rgba(0x6FB7FF, night ? 0.35 : 0.3).CGColor;
  _accent.hidden = NO;
  _accent.frame = CGRectMake(8, -1, std::max<CGFloat>(0, w - 16), 2);
  self.layer.shadowColor = night ? UIColor.blackColor.CGColor : rgba(0x1E3C78).CGColor;
  self.layer.shadowOpacity = night ? 0.55 : 0.35;
  self.layer.shadowRadius = 10;
  self.layer.shadowOffset = CGSizeMake(0, 8);
  self.layer.shadowPath = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0, 0, w, h) cornerRadius:11].CGPath;

  _tile.hidden = !c.showIcon;
  if (c.showIcon) {
    _tile.frame = CGRectMake(pad.left, (h - 24) / 2, 24, 24);
    _tile.layer.cornerRadius = 8;
    _tile.layer.borderWidth = 0;
    _tileGradient.hidden = NO;
    _tileGradient.frame = _tile.bounds;
    _tileGradient.cornerRadius = 8;
    UIColor *iconColor = rgba(maprama::iconColor(c.icon));
    UIColor *current = nil, *accent = iconColor;
    switch (tile) {
      case LabelTile::White:
        _tileGradient.colors = @[ (id)rgba(0xFFFFFF).CGColor, (id)rgba(0xEBF1F8).CGColor ];
        current = rgba(0x1C2330);
        _tile.layer.shadowColor = rgba(0x142850).CGColor;
        _tile.layer.shadowOpacity = 0.35;
        break;
      case LabelTile::Black:
        _tileGradient.colors = @[ (id)rgba(0x2B313D).CGColor, (id)rgba(0x10131A).CGColor ];
        current = rgba(0xF4F7FB);
        _tile.layer.shadowColor = UIColor.blackColor.CGColor;
        _tile.layer.shadowOpacity = 0.6;
        break;
      case LabelTile::Color:
        _tileGradient.colors = @[ (id)iconColor.CGColor, (id)iconColor.CGColor ];
        current = UIColor.whiteColor;
        accent = rgba(0xFFFFFF, 0.95);
        _tile.layer.shadowColor = iconColor.CGColor;
        _tile.layer.shadowOpacity = 0.8;
        break;
    }
    _tile.layer.shadowRadius = 4;
    _tile.layer.shadowOffset = CGSizeMake(0, 2);
    _iconHost.frame = _tile.bounds;
    drawIcon(_iconHost, &maprama::holoIcon(c.icon), CGRectMake(4.5, 4.5, 15, 15), current, accent);
  }
  const CGFloat textX = pad.left + icon + gap;
  const CGFloat textY = (h - textH) / 2;
  const CGFloat titleH = std::ceil(titleFont.pointSize * 1.18);
  _title.frame = CGRectMake(textX, textY, textW, titleH);
  _subtitle.frame = CGRectMake(textX, textY + titleH, textW, std::ceil(subFont.pointSize * 1.18));
  return CGSizeMake(w, h);
}

/// Character name tag (engine-web `.mpr-tag`: 12 px display font, line-height 1, padding 4 7 3, radius 8, 1.5 px
/// ink border; white with ink text, the player's tag filled with its colour (default #2F5BEA) and white text).
- (CGSize)configureTag:(const LabelCardContent &)c {
  UIFont *font = labelFont(12, UIFontWeightBold, NO, YES);
  UIColor *ink = rgba(0x2A2540);
  _title.attributedText = styled(ns(c.title), font, c.player ? UIColor.whiteColor : ink, 0);
  _title.layer.shadowOpacity = 0;
  _subtitle.hidden = YES;
  const CGSize t = [_title sizeThatFits:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)];
  const CGFloat border = 1.5;
  const CGFloat w = std::ceil(t.width) + 14 + 2 * border;
  const CGFloat h = 12 + 7 + 2 * border;
  _blur.hidden = YES;
  _gradient.hidden = YES;
  _innerRing.hidden = YES;
  _accent.hidden = YES;
  _tile.hidden = YES;
  _body.frame = CGRectMake(0, 0, w, h);
  _body.backgroundColor = c.player ? rgba(c.color) : UIColor.whiteColor;
  _body.layer.cornerRadius = 8;
  _body.layer.borderWidth = border;
  _body.layer.borderColor = ink.CGColor;
  self.layer.shadowOpacity = 0;
  self.layer.shadowPath = nil;
  // Text box: 12 dp tall (line-height 1) below the 4 dp top padding; the font's line box is centred on it.
  const CGFloat line = std::ceil(font.lineHeight);
  _title.frame = CGRectMake(border + 7, border + 4 + (12 - line) / 2, std::ceil(t.width), line);
  return CGSizeMake(w, h);
}

- (CGSize)configureApp:(const LabelCardContent &)c night:(BOOL)night {
  const AppLook k = appLook(c.visual, c, night);
  const bool poi = c.kind == LabelKind::Poi;
  const bool badge = poi && c.showIcon;
  const bool sub = poi && c.showSubtitle;
  UIFont *subFont = [k.font fontWithSize:k.font.pointSize * 0.72];
  _title.attributedText = styled(ns(c.title), k.font, k.color, k.kern);
  _subtitle.hidden = !sub;
  _subtitle.attributedText = styled(ns(c.subtitle), labelFont(subFont.pointSize, UIFontWeightMedium), [k.color colorWithAlphaComponent:0.8], 0.02);
  for (UILabel *l in @[ _title, _subtitle ]) {
    l.layer.shadowColor = k.halo.CGColor;
    l.layer.shadowOpacity = k.halo != nil ? 1 : 0;
    l.layer.shadowRadius = k.haloRadius;
  }
  const CGSize t = [_title sizeThatFits:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)];
  const CGSize s = sub ? [_subtitle sizeThatFits:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)] : CGSizeZero;
  const CGFloat textW = std::ceil(std::max(t.width, s.width)), textH = std::ceil(t.height + s.height);
  const CGFloat b = badge ? k.badge : 0, gap = badge ? k.gap : 0;
  const UIEdgeInsets pad = k.padding;
  const CGFloat w = pad.left + b + gap + textW + pad.right;
  const CGFloat h = pad.top + std::max(b, textH) + pad.bottom;

  _blur.hidden = YES;
  _gradient.hidden = YES;
  _innerRing.hidden = YES;
  _accent.hidden = YES;
  _body.frame = CGRectMake(0, 0, w, h);
  _body.backgroundColor = k.background ?: UIColor.clearColor;
  _body.layer.cornerRadius = k.background != nil ? std::min(k.radius, h / 2) : 0;
  _body.layer.borderWidth = k.border != nil ? k.borderWidth : 0;
  _body.layer.borderColor = k.border.CGColor;
  if (k.hardShadow) {
    self.layer.shadowColor = rgba(0x2A2540).CGColor;
    self.layer.shadowOpacity = 1;
    self.layer.shadowRadius = 0;
    self.layer.shadowOffset = CGSizeMake(0, 2);
  } else if (k.softShadow) {
    self.layer.shadowColor = rgba(0x283246).CGColor;
    self.layer.shadowOpacity = 0.3;
    self.layer.shadowRadius = 5;
    self.layer.shadowOffset = CGSizeMake(0, 2);
  } else {
    self.layer.shadowOpacity = 0;
  }
  self.layer.shadowPath =
      k.background != nil ? [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0, 0, w, h) cornerRadius:_body.layer.cornerRadius].CGPath : nil;

  _tile.hidden = !badge;
  if (badge) {
    _tile.frame = CGRectMake(pad.left, (h - b) / 2, b, b);
    _tile.layer.cornerRadius = b / 2;
    _tile.layer.borderWidth = k.ring;
    _tile.layer.borderColor = UIColor.whiteColor.CGColor;
    _tile.layer.shadowOpacity = k.badgeShadow ? 0.25 : 0;
    _tile.layer.shadowColor = UIColor.blackColor.CGColor;
    _tile.layer.shadowRadius = 2;
    _tile.layer.shadowOffset = CGSizeMake(0, 1);
    _tileGradient.hidden = NO;
    _tileGradient.frame = _tile.bounds;
    _tileGradient.cornerRadius = b / 2;
    UIColor *iconColor = rgba(maprama::iconColor(c.icon));
    _tileGradient.colors = @[ (id)iconColor.CGColor, (id)iconColor.CGColor ];
    _iconHost.frame = _tile.bounds;
    drawIcon(_iconHost, maprama::poiGlyph(c.icon), CGRectMake((b - k.glyph) / 2, (b - k.glyph) / 2, k.glyph, k.glyph), UIColor.whiteColor,
             UIColor.whiteColor);
  }
  const CGFloat textX = pad.left + b + gap, textY = pad.top + (std::max(b, textH) - textH) / 2;
  _title.frame = CGRectMake(textX, textY, textW, std::ceil(t.height));
  _subtitle.frame = CGRectMake(textX, textY + std::ceil(t.height), textW, std::ceil(s.height));
  return CGSizeMake(w, h);
}

@end

// ---------------------------------------------------------------------------------------------------------
// Holo ground dot (8 dp core with a white ring and a pulsing halo) and leader line.
// ---------------------------------------------------------------------------------------------------------

@interface MapramaHoloDot : UIView
@end

@implementation MapramaHoloDot {
  CALayer *_core;
  CALayer *_ring;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:CGRectMake(0, 0, 24, 24)]) {
    self.userInteractionEnabled = NO;
    self.isAccessibilityElement = NO;
    _ring = [CALayer layer];
    _ring.frame = self.bounds;
    _ring.cornerRadius = 12;
    _ring.borderWidth = 1.5;
    _ring.borderColor = rgba(0x6FB7FF, 0.75).CGColor;
    _ring.opacity = 0;
    [self.layer addSublayer:_ring];
    _core = [CALayer layer];
    _core.frame = CGRectMake(8, 8, 8, 8);
    _core.cornerRadius = 4;
    _core.backgroundColor = rgba(0x6FB7FF).CGColor;
    _core.borderWidth = 2;
    _core.borderColor = rgba(0xFFFFFF, 0.9).CGColor;
    _core.shadowColor = rgba(0x6FB7FF).CGColor;
    _core.shadowOpacity = 0.85;
    _core.shadowRadius = 6;
    _core.shadowOffset = CGSizeZero;
    [self.layer addSublayer:_core];
  }
  return self;
}

- (void)startPulse:(BOOL)animated {
  [_ring removeAllAnimations];
  [_core removeAllAnimations];
  if (!animated) return;
  CABasicAnimation *pop = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
  pop.fromValue = @0;
  pop.toValue = @1;
  pop.duration = 0.18;
  pop.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
  [_core addAnimation:pop forKey:@"pop"];
  CABasicAnimation *scale = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
  scale.fromValue = @0.3;
  scale.toValue = @1.5;
  CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
  fade.fromValue = @0.9;
  fade.toValue = @0;
  CAAnimationGroup *ring = [CAAnimationGroup animation];
  ring.animations = @[ scale, fade ];
  ring.duration = 1.8;
  ring.beginTime = CACurrentMediaTime() + 0.1;
  ring.repeatCount = HUGE_VALF;
  ring.removedOnCompletion = NO;
  ring.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
  [_ring addAnimation:ring forKey:@"pulse"];
}

@end

@interface MapramaHoloLine : UIView
@end

@implementation MapramaHoloLine {
  CAGradientLayer *_gradient;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.userInteractionEnabled = NO;
    self.isAccessibilityElement = NO;
    self.layer.anchorPoint = CGPointMake(0, 0.5);
    _gradient = [CAGradientLayer layer];
    _gradient.startPoint = CGPointMake(0, 0.5);
    _gradient.endPoint = CGPointMake(1, 0.5);
    _gradient.colors = @[ (id)rgba(0x6FB7FF, 0.25).CGColor, (id)rgba(0x6FB7FF, 0.95).CGColor ];
    [self.layer addSublayer:_gradient];
    self.layer.shadowColor = rgba(0x6FB7FF).CGColor;
    self.layer.shadowOpacity = 0.75;
    self.layer.shadowRadius = 3;
    self.layer.shadowOffset = CGSizeZero;
  }
  return self;
}

- (void)setFrom:(CGPoint)from to:(CGPoint)to {
  const CGFloat length = std::hypot(to.x - from.x, to.y - from.y);
  self.transform = CGAffineTransformIdentity;
  self.bounds = CGRectMake(0, 0, length, 1.5);
  self.center = from;  // anchor point (0, 0.5): the line starts at the ground dot
  self.transform = CGAffineTransformMakeRotation(std::atan2(to.y - from.y, to.x - from.x));
  _gradient.frame = self.bounds;
}

@end

// ---------------------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------------------

@interface MapramaLabelRecord : NSObject
@property(nonatomic, strong) MapramaLabelCardView *card;
@property(nonatomic, strong) MapramaHoloDot *dot;
@property(nonatomic, strong) MapramaHoloLine *line;
@end

@implementation MapramaLabelRecord {
 @public
  std::string key;
  LabelTile tile;
  BOOL night;
  /// The card's look (holo cards have a ground dot and a leader line; name tags and app styles do not).
  LabelVisual visual;
}
@end

@implementation MapramaLabelLayer {
  std::unordered_map<std::string, MapramaLabelRecord *> _active;
  NSMutableArray<MapramaLabelRecord *> *_free;
  /// Sequence of the last applied frame: a frame that hopped to the main queue may arrive after a newer one
  /// applied inline (camera reports run on the main thread, commands and game ticks on the JS thread).
  std::uint64_t _lastSequence;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.userInteractionEnabled = NO;  // touches reach the map below
    self.clipsToBounds = YES;
    _free = [NSMutableArray array];
  }
  return self;
}

- (MapramaLabelRecord *)takeRecord {
  MapramaLabelRecord *r = _free.lastObject;
  if (r != nil) {
    [_free removeLastObject];
    return r;
  }
  r = [[MapramaLabelRecord alloc] init];
  r.line = [[MapramaHoloLine alloc] initWithFrame:CGRectZero];
  r.dot = [[MapramaHoloDot alloc] initWithFrame:CGRectZero];
  r.card = [[MapramaLabelCardView alloc] initWithFrame:CGRectZero];
  [self addSubview:r.line];
  [self addSubview:r.dot];
  [self addSubview:r.card];
  return r;
}

- (void)hideRecord:(MapramaLabelRecord *)r {
  r.card.hidden = YES;
  r.dot.hidden = YES;
  r.line.hidden = YES;
  [r.card.layer removeAllAnimations];
  [r.dot startPulse:NO];
}

- (void)applyFrame:(const LabelFrame &)frame {
  if (frame.sequence != 0 && frame.sequence <= _lastSequence) return;  // stale: a newer frame is already shown
  _lastSequence = frame.sequence;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  const BOOL motion = !UIAccessibilityIsReduceMotionEnabled();
  std::unordered_map<std::string, MapramaLabelRecord *> next;
  next.reserve(frame.cards.size());
  NSMutableArray<MapramaLabelRecord *> *appeared = [NSMutableArray array];
  // Keep the views of labels that stay; free the others first so new labels can reuse them.
  for (auto &[id, r] : _active) {
    bool keep = false;
    for (const LabelCard &c : frame.cards) keep = keep || c.id == id;
    if (!keep) {
      [self hideRecord:r];
      [_free addObject:r];
    }
  }
  for (const LabelCard &c : frame.cards) {
    MapramaLabelRecord *r = nil;
    auto it = _active.find(c.id);
    const bool fresh = it == _active.end();
    r = fresh ? [self takeRecord] : it->second;
    if (fresh || r->key != c.content.key || r->tile != frame.tile || r->night != frame.night) {
      [r.card configure:c.content tile:frame.tile night:frame.night];
      r->key = c.content.key;
      r->tile = frame.tile;
      r->night = frame.night;
    }
    r->visual = c.content.visual;
    const bool holo = r->visual == LabelVisual::Holo;
    r.card.hidden = NO;
    r.card.transform = CGAffineTransformIdentity;
    r.card.bounds = CGRectMake(0, 0, c.width, c.height);
    r.card.center = CGPointMake(c.x, c.y);
    r.card.transform = CGAffineTransformMakeRotation(c.angle);
    r.card.alpha = c.opacity;
    r.card.accessibilityIdentifier = [@"maprama-label-" stringByAppendingString:ns(c.id)];
    r.dot.hidden = !holo;
    r.line.hidden = !holo;
    if (holo) {
      r.dot.center = CGPointMake(c.dotX, c.dotY);
      [r.line setFrom:CGPointMake(c.dotX, c.dotY) to:CGPointMake(c.lineX, c.lineY)];
    }
    if (fresh) [appeared addObject:r];
    next.emplace(c.id, r);
  }
  _active.swap(next);
  if (appeared.count > 0) {
    // Draw order: leader lines, then dots, then cards (frame order).
    for (const LabelCard &c : frame.cards) [self bringSubviewToFront:_active[c.id].line];
    for (const LabelCard &c : frame.cards) [self bringSubviewToFront:_active[c.id].dot];
    for (const LabelCard &c : frame.cards) [self bringSubviewToFront:_active[c.id].card];
  }
  [CATransaction commit];
  // Pop-in (engine-web: dot, then line, then the card).
  for (MapramaLabelRecord *r in appeared) {
    if (r->visual == LabelVisual::Holo) {
      [r.dot startPulse:motion];
      if (!motion) continue;
      CABasicAnimation *grow = [CABasicAnimation animationWithKeyPath:@"transform.scale.x"];
      grow.fromValue = @0;
      grow.toValue = @1;
      grow.duration = 0.22;
      grow.beginTime = CACurrentMediaTime() + 0.06;
      grow.fillMode = kCAFillModeBackwards;
      grow.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.2:0.8:0.2:1];
      [r.line.layer addAnimation:grow forKey:@"grow"];
      CABasicAnimation *scale = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
      scale.fromValue = @0.72;
      scale.toValue = @1;
      CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
      fade.fromValue = @0;
      fade.toValue = @1;
      CAAnimationGroup *pop = [CAAnimationGroup animation];
      pop.animations = @[ scale, fade ];
      pop.duration = 0.28;
      pop.beginTime = CACurrentMediaTime() + 0.2;
      pop.fillMode = kCAFillModeBackwards;
      pop.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.2:0.9:0.25:1.25];
      [r.card.layer addAnimation:pop forKey:@"pop"];
    } else if (motion && r->visual == LabelVisual::Clean) {
      CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
      fade.fromValue = @0;
      fade.toValue = @1;
      fade.duration = 0.25;
      [r.card.layer addAnimation:fade forKey:@"fade"];
    }
  }
}

+ (std::vector<maprama::LabelSize>)measure:(const std::vector<LabelCardContent> &)items {
  static MapramaLabelCardView *scratch = nil;
  if (scratch == nil) scratch = [[MapramaLabelCardView alloc] initWithFrame:CGRectZero];
  std::vector<maprama::LabelSize> sizes;
  sizes.reserve(items.size());
  for (const LabelCardContent &c : items) {
    const CGSize s = [scratch configure:c tile:LabelTile::White night:NO];
    sizes.push_back(maprama::LabelSize{s.width, s.height});
  }
  return sizes;
}

@end
