package dev.maprama.enginenative

import android.animation.TimeInterpolator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Native label views for the core's label placement (DESIGN.md §6.5, M2b). The core (`LabelSystem`) selects,
 * projects and declutters labels; this layer only draws the placed cards of each frame (views recycled by
 * label id) and measures cards for the core. Styles follow engine-web's stylesheet (`holo` glass card with a
 * ground dot and leader line, `app`, `minimal`, `clean`, `sticker`); icons are engine-web's line icons from
 * the vector table generated into the core (`maprama/LabelIcons.hpp`, fetched once through JNI).
 *
 * Touches pass through to the map (nothing here is clickable); each visible card is an accessibility node
 * with the core's "name, type" label.
 */
internal class MapramaLabelLayer(context: Context, private val density: Float) : FrameLayout(context) {
  private class Record(val card: LabelCardView) {
    var key = ""
    var tile = -1
    var night = false
    var holo = false
    var appearedAt = 0L
    var dotX = 0f
    var dotY = 0f
    var lineX = 0f
    var lineY = 0f
  }

  private val active = HashMap<String, Record>()
  private val free = ArrayList<Record>()
  private val order = ArrayList<Record>()
  private val scratch = LabelCardView(context, density)
  private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val overshoot: TimeInterpolator = OvershootInterpolator(1.6f)

  init {
    setWillNotDraw(false)
    clipChildren = true
    isClickable = false
    isFocusable = false
  }

  private fun motion(): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f

  /** Card sizes (dp) for the core's `measureLabels`: [w0, h0, w1, h1, …]. */
  fun measure(items: List<LabelContentData>): DoubleArray {
    val out = DoubleArray(items.size * 2)
    items.forEachIndexed { i, c ->
      val size = scratch.configure(c, LabelConst.TILE_WHITE, false)
      out[i * 2] = size.first.toDouble()
      out[i * 2 + 1] = size.second.toDouble()
    }
    return out
  }

  fun apply(frame: LabelFrameData) {
    val holo = frame.visual == LabelConst.VISUAL_HOLO
    val animate = motion()
    val now = SystemClock.uptimeMillis()
    val ids = HashSet<String>(frame.cards.size * 2)
    for (c in frame.cards) ids.add(c.id)
    val gone = active.keys.filter { it !in ids }
    for (id in gone) {
      val r = active.remove(id) ?: continue
      r.card.animate().cancel()
      r.card.visibility = View.GONE
      r.holo = false
      free.add(r)
    }
    var appeared = false
    order.clear()
    for (c in frame.cards) {
      var r = active[c.id]
      val fresh = r == null
      if (r == null) {
        r = if (free.isNotEmpty()) free.removeAt(free.size - 1) else Record(LabelCardView(context, density)).also { addView(it.card) }
        active[c.id] = r
      }
      if (fresh || r.key != c.content.key || r.tile != frame.tile || r.night != frame.night) {
        val (w, h) = r.card.configure(c.content, frame.tile, frame.night)
        val wp = ceil(w * density).toInt()
        val hp = ceil(h * density).toInt()
        r.card.layoutParams = LayoutParams(wp, hp)
        r.card.measure(MeasureSpec.makeMeasureSpec(wp, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(hp, MeasureSpec.EXACTLY))
        r.card.layout(0, 0, wp, hp)
        r.key = c.content.key
        r.tile = frame.tile
        r.night = frame.night
      }
      val card = r.card
      card.visibility = View.VISIBLE
      card.pivotX = card.width / 2f
      card.pivotY = card.height / 2f
      card.translationX = (c.x * density).toFloat() - card.width / 2f
      card.translationY = (c.y * density).toFloat() - card.height / 2f
      card.rotation = (c.angle * 180.0 / PI).toFloat()
      card.labelId = c.id
      r.holo = holo
      r.dotX = (c.dotX * density).toFloat()
      r.dotY = (c.dotY * density).toFloat()
      r.lineX = (c.lineX * density).toFloat()
      r.lineY = (c.lineY * density).toFloat()
      if (fresh) {
        appeared = true
        r.appearedAt = now
        card.animate().cancel()
        if (animate && holo) {
          card.alpha = 0f
          card.scaleX = 0.72f
          card.scaleY = 0.72f
          card.animate().alpha(c.opacity.toFloat()).scaleX(1f).scaleY(1f).setStartDelay(200).setDuration(280)
            .setInterpolator(overshoot).start()
        } else if (animate && frame.visual == LabelConst.VISUAL_CLEAN) {
          card.alpha = 0f
          card.scaleX = 1f
          card.scaleY = 1f
          card.animate().alpha(c.opacity.toFloat()).setStartDelay(0).setDuration(250).start()
        } else {
          card.alpha = c.opacity.toFloat()
          card.scaleX = 1f
          card.scaleY = 1f
        }
      } else if (!animate || now - r.appearedAt > 520) {
        card.alpha = c.opacity.toFloat()  // not while the pop-in animates it
      }
      order.add(r)
    }
    if (appeared) for (r in order) r.card.bringToFront()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val now = SystemClock.uptimeMillis()
    val animate = motion()
    var pulsing = false
    val s = density
    for (r in order) {
      if (!r.holo || r.card.visibility != View.VISIBLE) continue
      val age = (now - r.appearedAt).toFloat()
      // Leader line: grows from the dot (engine-web: .22 s after .06 s).
      val grow = if (animate) ((age - 60f) / 220f).coerceIn(0f, 1f) else 1f
      if (grow > 0f) {
        val ex = r.dotX + (r.lineX - r.dotX) * grow
        val ey = r.dotY + (r.lineY - r.dotY) * grow
        linePaint.strokeWidth = 1.5f * s
        linePaint.shader = LinearGradient(r.dotX, r.dotY, ex, ey, Color.argb(64, 111, 183, 255), Color.argb(242, 111, 183, 255), Shader.TileMode.CLAMP)
        linePaint.setShadowLayer(3f * s, 0f, 0f, Color.argb(190, 111, 183, 255))
        canvas.drawLine(r.dotX, r.dotY, ex, ey, linePaint)
      }
      // Pulsing halo ring (1.8 s, from .1 s).
      if (animate) {
        val t = ((age - 100f) % 1800f) / 1800f
        if (age > 100f) {
          dotPaint.style = Paint.Style.STROKE
          dotPaint.strokeWidth = 1.5f * s
          dotPaint.shader = null
          dotPaint.clearShadowLayer()
          dotPaint.color = Color.argb((191 * (0.9f * (1f - t))).toInt(), 111, 183, 255)
          canvas.drawCircle(r.dotX, r.dotY, 12f * s * (0.3f + 1.2f * t), dotPaint)
        }
        pulsing = true
      }
      // Dot: 8 dp, white ring, glow; pops in over .18 s.
      val pop = if (animate) (age / 180f).coerceIn(0f, 1f) else 1f
      dotPaint.shader = null
      dotPaint.style = Paint.Style.FILL
      dotPaint.color = Color.argb(230, 255, 255, 255)
      dotPaint.setShadowLayer(6f * s, 0f, 0f, Color.argb(217, 111, 183, 255))
      canvas.drawCircle(r.dotX, r.dotY, 6f * s * pop, dotPaint)
      dotPaint.clearShadowLayer()
      dotPaint.color = Color.rgb(111, 183, 255)
      canvas.drawCircle(r.dotX, r.dotY, 4f * s * pop, dotPaint)
    }
    if (pulsing) postInvalidateOnAnimation()
  }
}

/** Constants shared with the core (enum orders of `LabelVisual`, `LabelTile`, `LabelKind`, `LabelIcon`). */
internal object LabelConst {
  const val VISUAL_HOLO = 0
  const val VISUAL_APP = 1
  const val VISUAL_MINIMAL = 2
  const val VISUAL_CLEAN = 3
  const val VISUAL_STICKER = 4
  const val TILE_WHITE = 0
  const val TILE_BLACK = 1
  const val TILE_COLOR = 2
  const val KIND_ROAD = 0
  const val KIND_DISTRICT = 1
  const val KIND_POI = 2
}

/** `maprama::LabelCardContent` (flags: 1 water, 2 arterial, 4 showIcon, 8 showSubtitle, 16 custom). */
internal class LabelContentData(
  val key: String,
  val visual: Int,
  val kind: Int,
  val flags: Int,
  val icon: Int,
  val title: String,
  val subtitle: String,
  val accessibilityLabel: String,
) {
  val water get() = flags and 1 != 0
  val arterial get() = flags and 2 != 0
  val showIcon get() = flags and 4 != 0
  val showSubtitle get() = flags and 8 != 0
  val custom get() = flags and 16 != 0

  companion object {
    /** Decodes JNI arrays: 3 strings (title, subtitle, accessibility label) and 4 ints (visual, kind, flags, icon) per item. */
    fun list(keys: Array<String>?, strings: Array<String>, ints: IntArray): List<LabelContentData> =
      List(ints.size / 4) { i ->
        LabelContentData(
          keys?.get(i) ?: "",
          ints[i * 4],
          ints[i * 4 + 1],
          ints[i * 4 + 2],
          ints[i * 4 + 3],
          strings[i * 3],
          strings[i * 3 + 1],
          strings[i * 3 + 2],
        )
      }
  }
}

/** One placed card (`maprama::LabelCard`), dp. */
internal class LabelCardData(
  val id: String,
  val content: LabelContentData,
  val x: Double,
  val y: Double,
  val angle: Double,
  val opacity: Double,
  val dotX: Double,
  val dotY: Double,
  val lineX: Double,
  val lineY: Double,
)

internal class LabelFrameData(val visual: Int, val tile: Int, val night: Boolean, val cards: List<LabelCardData>) {
  companion object {
    /** 10 numbers per card: x, y, width, height, angle, opacity, dotX, dotY, lineX, lineY. */
    fun decode(visual: Int, tile: Int, night: Boolean, ids: Array<String>, keys: Array<String>, strings: Array<String>, ints: IntArray, numbers: DoubleArray): LabelFrameData {
      val contents = LabelContentData.list(keys, strings, ints)
      val cards = List(ids.size) { i ->
        val n = i * 10
        LabelCardData(ids[i], contents[i], numbers[n], numbers[n + 1], numbers[n + 4], numbers[n + 5], numbers[n + 6], numbers[n + 7], numbers[n + 8], numbers[n + 9])
      }
      return LabelFrameData(visual, tile, night, cards)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Icons (vector table from the core)
// ---------------------------------------------------------------------------------------------------------

internal class IconShapeData(val path: Path, val fill: Int, val fillOpacity: Float, val stroke: Int, val strokeWidth: Float)

internal class IconDrawingData(val color: Int, val size: Float, val roundCaps: Boolean, val text: String?, val shapes: List<IconShapeData>) {
  companion object {
    private const val PAINT_NONE = 0
    private const val PAINT_CURRENT = 1
    private const val PAINT_ACCENT = 2
    private val holo = HashMap<Int, IconDrawingData?>()
    private val glyphs = HashMap<Int, IconDrawingData?>()

    fun holo(icon: Int): IconDrawingData? = holo.getOrPut(icon) { decode(MapramaJni.labelIconData(false, icon)) }

    fun glyph(icon: Int): IconDrawingData? = glyphs.getOrPut(icon) { decode(MapramaJni.labelIconData(true, icon)) }

    /** [color, size, roundCaps, textLength, text code points…, shapeCount, (fill, fillOpacity, stroke, strokeWidth, opCount, ops…, coordCount, coords…)…] */
    private fun decode(data: FloatArray?): IconDrawingData? {
      if (data == null || data.size < 5) return null
      var i = 0
      val color = data[i++].toInt()
      val size = data[i++]
      val round = data[i++] != 0f
      val textLength = data[i++].toInt()
      val text = if (textLength > 0) String(IntArray(textLength) { data[i + it].toInt() }, 0, textLength) else null
      i += textLength
      val shapeCount = data[i++].toInt()
      val shapes = ArrayList<IconShapeData>(shapeCount)
      repeat(shapeCount) {
        val fill = data[i++].toInt()
        val fillOpacity = data[i++]
        val stroke = data[i++].toInt()
        val strokeWidth = data[i++]
        val opCount = data[i++].toInt()
        val ops = IntArray(opCount) { data[i + it].toInt() }
        i += opCount
        val coordCount = data[i++].toInt()
        var c = i
        i += coordCount
        val path = Path()
        for (op in ops) {
          when (op) {
            0 -> { path.moveTo(data[c], data[c + 1]); c += 2 }
            1 -> { path.lineTo(data[c], data[c + 1]); c += 2 }
            2 -> { path.cubicTo(data[c], data[c + 1], data[c + 2], data[c + 3], data[c + 4], data[c + 5]); c += 6 }
            else -> path.close()
          }
        }
        shapes.add(IconShapeData(path, fill, fillOpacity, stroke, strokeWidth))
      }
      return IconDrawingData(color, size, round, text, shapes)
    }

    fun paintColor(paint: Int, current: Int, accent: Int, opacity: Float): Int? {
      val c = when (paint) {
        PAINT_NONE -> return null
        PAINT_CURRENT -> current
        PAINT_ACCENT -> accent
        else -> Color.WHITE
      }
      return if (opacity >= 1f) c else Color.argb((Color.alpha(c) * opacity).toInt(), Color.red(c), Color.green(c), Color.blue(c))
    }
  }

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  /** Draws into [rect] (px) with `currentColor` = [current] and `var(--c)` = [accent]. */
  fun draw(canvas: Canvas, rect: RectF, current: Int, accent: Int) {
    if (text != null) {
      paint.style = Paint.Style.FILL
      paint.shader = null
      paint.color = Color.WHITE
      paint.typeface = Typeface.DEFAULT_BOLD
      paint.textSize = rect.height() * 0.8f
      paint.textAlign = Paint.Align.CENTER
      val fm = paint.fontMetrics
      canvas.drawText(text, rect.centerX(), rect.centerY() - (fm.ascent + fm.descent) / 2, paint)
      paint.textAlign = Paint.Align.LEFT
      return
    }
    val scale = rect.width() / size
    canvas.save()
    canvas.translate(rect.left, rect.top)
    canvas.scale(scale, scale)
    paint.shader = null
    paint.strokeCap = if (roundCaps) Paint.Cap.ROUND else Paint.Cap.BUTT
    paint.strokeJoin = if (roundCaps) Paint.Join.ROUND else Paint.Join.MITER
    for (s in shapes) {
      paintColor(s.fill, current, accent, s.fillOpacity)?.let {
        paint.style = Paint.Style.FILL
        paint.color = it
        canvas.drawPath(s.path, paint)
      }
      paintColor(s.stroke, current, accent, 1f)?.let {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = s.strokeWidth
        paint.color = it
        canvas.drawPath(s.path, paint)
      }
    }
    canvas.restore()
  }
}

// ---------------------------------------------------------------------------------------------------------
// One card (holo glass card or app-style label), drawn on a canvas; sizes in dp.
// ---------------------------------------------------------------------------------------------------------

internal class LabelCardView(context: Context, private val density: Float) : View(context) {
  private class Text(val sizeDp: Float, val weight: Int, val italic: Boolean, val color: Int, val kernEm: Float, val halo: Int? = null, val haloDp: Float = 0f)

  /** engine-web look of one app-style label (dom-styles.ts `.mpr-ml*`, `.ls-*`, `.night`). */
  private class AppLook(
    val title: Text,
    val background: Int? = null,
    val border: Int? = null,
    val borderDp: Float = 0f,
    val radiusDp: Float = 999f,
    val pad: FloatArray = floatArrayOf(0f, 0f, 0f, 0f), // top, right, bottom, left
    val hardShadow: Boolean = false,
    val softShadow: Boolean = false,
    val badge: Float = 18f,
    val glyph: Float = 12f,
    val gap: Float = 4f,
    val ring: Float = 1.5f,
  )

  /** Label id of the card currently shown (accessibility resource id `maprama-label-<id>`). */
  var labelId: String? = null
  private var content: LabelContentData? = null
  private var tile = LabelConst.TILE_WHITE
  private var night = false
  private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val subPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val rect = RectF()

  // Layout (dp).
  private var w = 0f
  private var h = 0f
  private var iconX = 0f
  private var iconY = 0f
  private var iconSize = 0f
  private var textX = 0f
  private var titleTop = 0f
  private var titleH = 0f
  private var subTop = 0f
  private var subH = 0f
  private var look: AppLook? = null

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    labelId?.let { info.viewIdResourceName = "maprama-label-$it" }
  }

  private fun typeface(weight: Int, italic: Boolean): Typeface =
    if (Build.VERSION.SDK_INT >= 28) {
      Typeface.create(Typeface.DEFAULT, weight, italic)
    } else {
      val base = if (weight >= 500 && weight < 700) Typeface.create("sans-serif-medium", Typeface.NORMAL) else Typeface.DEFAULT
      Typeface.create(base, (if (weight >= 700) Typeface.BOLD else 0) or (if (italic) Typeface.ITALIC else 0))
    }

  private fun apply(p: Paint, t: Text, sizeScale: Float = 1f) {
    p.typeface = typeface(t.weight, t.italic)
    p.textSize = t.sizeDp * sizeScale * density
    p.letterSpacing = t.kernEm
    p.color = t.color
    if (t.halo != null) p.setShadowLayer(t.haloDp * density, 0f, 0f, t.halo) else p.clearShadowLayer()
  }

  private fun lineHeightDp(p: Paint): Float = (p.fontMetrics.descent - p.fontMetrics.ascent) / density

  private fun widthDp(p: Paint, text: String): Float = p.measureText(text) / density

  /** Configures the card and returns its size (dp). */
  fun configure(c: LabelContentData, tile: Int, night: Boolean): Pair<Float, Float> {
    content = c
    this.tile = tile
    this.night = night
    contentDescription = c.accessibilityLabel
    if (c.visual == LabelConst.VISUAL_HOLO) layoutHolo(c) else layoutApp(c)
    invalidate()
    return Pair(w, h)
  }

  private fun layoutHolo(c: LabelContentData) {
    look = null
    val district = c.kind == LabelConst.KIND_DISTRICT
    // engine-web .mpr-hl-card: padding 5 11 5 5 (district 7 14 7 7, text only 6 12), gap 7.
    val pad = if (!c.showIcon) floatArrayOf(6f, 12f, 6f, 12f) else if (district) floatArrayOf(7f, 14f, 7f, 7f) else floatArrayOf(5f, 11f, 5f, 5f)
    val titleT = Text(if (district) 14f else 12f, 600, false, if (night) 0xFFEAF2FF.toInt() else 0xFF1E2533.toInt(), if (district) 0.14f else 0f)
    val subColor = if (c.custom) (if (night) 0xFF8FC3FF.toInt() else 0xFF2F6BFF.toInt()) else (if (night) 0xFF9FB6D6.toInt() else 0xFF5C6B80.toInt())
    val subT = Text(if (c.custom) 10f else 8.5f, 600, false, subColor, if (c.custom) 0.01f else 0.08f)
    apply(titlePaint, titleT)
    apply(subPaint, subT)
    val textW = ceil(max(widthDp(titlePaint, c.title), if (c.showSubtitle) widthDp(subPaint, c.subtitle) else 0f))
    titleH = ceil(titleT.sizeDp * 1.18f)
    subH = if (c.showSubtitle) ceil(subT.sizeDp * 1.18f) else 0f
    val textH = titleH + subH
    iconSize = if (c.showIcon) 24f else 0f
    val gap = if (c.showIcon) 7f else 0f
    w = pad[3] + iconSize + gap + textW + pad[1]
    h = pad[0] + max(iconSize, textH) + pad[2]
    iconX = pad[3]
    iconY = (h - iconSize) / 2
    textX = pad[3] + iconSize + gap
    titleTop = (h - textH) / 2
    subTop = titleTop + titleH
  }

  private fun appLook(c: LabelContentData): AppLook {
    val district = c.kind == LabelConst.KIND_DISTRICT && !c.water
    val water = c.kind == LabelConst.KIND_DISTRICT && c.water
    val road = c.kind == LabelConst.KIND_ROAD
    val art = road && c.arterial
    val white = Color.WHITE
    val dark = 0xFF0B1020.toInt()
    return when (c.visual) {
      LabelConst.VISUAL_MINIMAL -> {
        fun t(size: Float, weight: Int, color: Int, kern: Float = 0f, italic: Boolean = false) = Text(size, weight, italic, color, kern, white, 2.5f)
        when {
          district -> AppLook(t(12.5f, 600, 0xFF454B57.toInt(), 0.5f))
          water -> AppLook(t(12f, 500, 0xFF3A404B.toInt(), 0.4f, true))
          road -> AppLook(t(10.5f, if (art) 600 else 500, if (art) 0xFF6E4F1A.toInt() else 0xFF4A505B.toInt()))
          else -> AppLook(t(10.5f, 500, 0xFF3A404B.toInt()), badge = 12f, glyph = 8f, gap = 3f, ring = 1f)
        }
      }
      LabelConst.VISUAL_STICKER -> {
        val ink = 0xFF2A2540.toInt()
        when {
          district -> AppLook(Text(14f, 600, false, white, 0.28f), background = ink, border = ink, borderDp = 1.5f, pad = floatArrayOf(4f, 12f, 3f, 12f), hardShadow = true)
          water -> AppLook(Text(13f, 500, false, 0xFF1F5E8C.toInt(), 0.32f), background = 0xFFDDEFFB.toInt(), border = ink, borderDp = 1.5f, pad = floatArrayOf(3f, 9f, 2f, 9f), hardShadow = true)
          road -> AppLook(Text(11.5f, 400, false, ink, 0f), background = if (art) 0xFFFFE7A8.toInt() else white, border = ink, borderDp = 1.5f, pad = floatArrayOf(3f, 9f, 2f, 9f), hardShadow = true)
          else -> AppLook(Text(11.5f, 400, false, ink, 0f), background = white, border = ink, borderDp = 1.5f, pad = floatArrayOf(2f, 9f, 2f, 2f), hardShadow = true)
        }
      }
      LabelConst.VISUAL_CLEAN -> {
        val halo = if (night) dark else white
        val haloDp = if (night) 3.5f else 2.5f
        val base = if (night) 0xFFEEF2F8.toInt() else 0xFF2B313C.toInt()
        fun t(size: Float, weight: Int, color: Int, kern: Float = 0f) = Text(size, weight, false, if (night) base else color, kern, halo, haloDp)
        when {
          district -> AppLook(t(13f, 700, 0xFF343A46.toInt(), 0.42f))
          water -> AppLook(t(12f, 600, 0xFF2A6C9C.toInt(), 0.42f))
          art -> AppLook(
            Text(12f, 700, false, if (night) 0xFFF3F5FA.toInt() else 0xFF252B35.toInt(), 0.02f),
            background = if (night) Color.argb(184, 20, 26, 40) else Color.argb(204, 255, 255, 255),
            border = if (night) Color.argb(46, 255, 255, 255) else Color.argb(242, 255, 255, 255),
            borderDp = 1f,
            radiusDp = 6f,
            pad = floatArrayOf(2f, 8f, 2f, 8f),
            softShadow = true,
          )
          road -> AppLook(t(12f, 700, 0xFF2F3540.toInt(), 0.02f))
          else -> AppLook(t(11f, 600, base), badge = 15f, glyph = 9f, gap = 5f)
        }
      }
      else -> {
        val halo = if (night) dark else white
        val haloDp = if (night) 3.5f else 2.5f
        val base = if (night) 0xFFE8ECF5.toInt() else 0xFF2F3440.toInt()
        fun t(size: Float, weight: Int, color: Int, kern: Float = 0f, italic: Boolean = false) = Text(size, weight, italic, color, kern, halo, haloDp)
        when {
          district -> AppLook(t(15f, 600, if (night) 0xFFC9D2E6.toInt() else 0xFF474C58.toInt(), 0.28f))
          water -> AppLook(t(13f, 500, if (night) base else 0xFF2F6F9E.toInt(), 0.32f, true))
          road -> AppLook(t(11f, if (art) 600 else 500, if (art) (if (night) 0xFFF3D08A.toInt() else 0xFF6A4712.toInt()) else (if (night) base else 0xFF565C67.toInt())))
          else -> AppLook(t(11.5f, 600, base))
        }
      }
    }
  }

  private fun layoutApp(c: LabelContentData) {
    val k = appLook(c)
    look = k
    val poi = c.kind == LabelConst.KIND_POI
    val badge = poi && c.showIcon
    val sub = poi && c.showSubtitle
    apply(titlePaint, k.title)
    apply(subPaint, Text(k.title.sizeDp * 0.72f, 500, false, Color.argb(204, Color.red(k.title.color), Color.green(k.title.color), Color.blue(k.title.color)), 0.02f, k.title.halo, k.title.haloDp))
    val textW = ceil(max(widthDp(titlePaint, c.title), if (sub) widthDp(subPaint, c.subtitle) else 0f))
    titleH = ceil(lineHeightDp(titlePaint))
    subH = if (sub) ceil(lineHeightDp(subPaint)) else 0f
    val textH = titleH + subH
    iconSize = if (badge) k.badge else 0f
    val gap = if (badge) k.gap else 0f
    w = k.pad[3] + iconSize + gap + textW + k.pad[1]
    h = k.pad[0] + max(iconSize, textH) + k.pad[2]
    iconX = k.pad[3]
    iconY = (h - iconSize) / 2
    textX = k.pad[3] + iconSize + gap
    titleTop = k.pad[0] + (max(iconSize, textH) - textH) / 2
    subTop = titleTop + titleH
  }

  private fun drawText(canvas: Canvas, p: Paint, text: String, xDp: Float, topDp: Float, lineDp: Float) {
    val fm = p.fontMetrics
    val baseline = topDp * density + (lineDp * density - (fm.descent - fm.ascent)) / 2 - fm.ascent
    canvas.drawText(text, xDp * density, baseline, p)
  }

  override fun onDraw(canvas: Canvas) {
    val c = content ?: return
    val s = density
    if (c.visual == LabelConst.VISUAL_HOLO) {
      // Glass card (no backdrop blur on Android: a denser gradient instead), border, inset ring, accent line.
      rect.set(0.5f * s, 0.5f * s, w * s - 0.5f * s, h * s - 0.5f * s)
      fill.style = Paint.Style.FILL
      fill.shader = LinearGradient(
        0f, 0f, w * s, h * s,
        if (night) Color.argb(224, 18, 26, 46) else Color.argb(235, 255, 255, 255),
        if (night) Color.argb(196, 26, 42, 78) else Color.argb(214, 230, 241, 255),
        Shader.TileMode.CLAMP,
      )
      canvas.drawRoundRect(rect, 11f * s, 11f * s, fill)
      fill.shader = null
      fill.style = Paint.Style.STROKE
      fill.strokeWidth = 1f * s
      fill.color = if (night) Color.argb(115, 140, 190, 255) else Color.argb(242, 255, 255, 255)
      canvas.drawRoundRect(rect, 11f * s, 11f * s, fill)
      rect.inset(1f * s, 1f * s)
      fill.color = Color.argb(if (night) 89 else 77, 111, 183, 255)
      canvas.drawRoundRect(rect, 10f * s, 10f * s, fill)
      fill.style = Paint.Style.FILL
      fill.shader = LinearGradient(8f * s, 0f, (w - 8f) * s, 0f, intArrayOf(Color.argb(0, 111, 183, 255), Color.rgb(111, 183, 255), Color.argb(0, 111, 183, 255)), null, Shader.TileMode.CLAMP)
      rect.set(8f * s, 0f, (w - 8f) * s, 2f * s)
      canvas.drawRoundRect(rect, 1f * s, 1f * s, fill)
      fill.shader = null
      if (c.showIcon) {
        val icon = IconDrawingData.holo(c.icon)
        val iconColor = icon?.color?.let { Color.rgb((it shr 16) and 0xFF, (it shr 8) and 0xFF, it and 0xFF) } ?: Color.rgb(62, 123, 250)
        rect.set(iconX * s, iconY * s, (iconX + 24f) * s, (iconY + 24f) * s)
        var current = Color.rgb(28, 35, 48)
        var accent = iconColor
        fill.shader = when (tile) {
          LabelConst.TILE_BLACK -> {
            current = Color.rgb(244, 247, 251)
            LinearGradient(rect.left, rect.top, rect.right, rect.bottom, Color.rgb(43, 49, 61), Color.rgb(16, 19, 26), Shader.TileMode.CLAMP)
          }
          LabelConst.TILE_COLOR -> {
            current = Color.WHITE
            accent = Color.argb(242, 255, 255, 255)
            null
          }
          else -> LinearGradient(rect.left, rect.top, rect.right, rect.bottom, Color.WHITE, Color.rgb(235, 241, 248), Shader.TileMode.CLAMP)
        }
        fill.color = iconColor
        canvas.drawRoundRect(rect, 8f * s, 8f * s, fill)
        fill.shader = null
        if (tile == LabelConst.TILE_WHITE) {
          fill.style = Paint.Style.STROKE
          fill.strokeWidth = 1f * s
          fill.color = Color.argb(23, 20, 30, 50)
          canvas.drawRoundRect(rect, 8f * s, 8f * s, fill)
          fill.style = Paint.Style.FILL
        }
        icon?.draw(canvas, RectF(rect.left + 4.5f * s, rect.top + 4.5f * s, rect.left + 19.5f * s, rect.top + 19.5f * s), current, accent)
      }
      drawText(canvas, titlePaint, c.title, textX, titleTop, titleH)
      if (c.showSubtitle) drawText(canvas, subPaint, c.subtitle, textX, subTop, subH)
      return
    }
    val k = look ?: return
    if (k.background != null) {
      val radius = min(k.radiusDp, h / 2) * s
      val inset = k.borderDp * s / 2
      if (k.hardShadow) {
        fill.style = Paint.Style.FILL
        fill.color = 0xFF2A2540.toInt()
        rect.set(inset, inset + 2f * s, w * s - inset, h * s - inset + 2f * s)
        canvas.drawRoundRect(rect, radius, radius, fill)
      }
      rect.set(inset, inset, w * s - inset, h * s - inset)
      fill.style = Paint.Style.FILL
      fill.color = k.background
      if (k.softShadow) fill.setShadowLayer(5f * s, 0f, 2f * s, Color.argb(77, 40, 50, 70)) else fill.clearShadowLayer()
      canvas.drawRoundRect(rect, radius, radius, fill)
      fill.clearShadowLayer()
      if (k.border != null) {
        fill.style = Paint.Style.STROKE
        fill.strokeWidth = k.borderDp * s
        fill.color = k.border
        canvas.drawRoundRect(rect, radius, radius, fill)
        fill.style = Paint.Style.FILL
      }
    }
    if (iconSize > 0f) {
      val glyph = IconDrawingData.glyph(c.icon)
      val color = IconDrawingData.holo(c.icon)?.color ?: 0x3E7BFA
      val cx = (iconX + iconSize / 2) * s
      val cy = (iconY + iconSize / 2) * s
      fill.style = Paint.Style.FILL
      fill.color = Color.WHITE
      canvas.drawCircle(cx, cy, (iconSize / 2) * s, fill)
      fill.color = Color.rgb((color shr 16) and 0xFF, (color shr 8) and 0xFF, color and 0xFF)
      canvas.drawCircle(cx, cy, (iconSize / 2 - k.ring) * s, fill)
      val g = k.glyph * s
      glyph?.draw(canvas, RectF(cx - g / 2, cy - g / 2, cx + g / 2, cy + g / 2), Color.WHITE, Color.WHITE)
    }
    drawText(canvas, titlePaint, c.title, textX, titleTop, titleH)
    if (subH > 0f) drawText(canvas, subPaint, c.subtitle, textX, subTop, subH)
  }
}
