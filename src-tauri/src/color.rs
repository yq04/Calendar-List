//! 色彩科学层：sRGB <-> OKLab、WCAG 对比度、色域裁剪。
//!
//! 为什么取色与配色都放在 OKLab 而不是 RGB / HSL：
//!   1. 感知均匀 —— 只有在这里做 k-means，簇间欧氏距离才近似等于「看起来的差异」；
//!   2. 明度单调可控 —— 固定 a/b 后对比度随 L 单调，二分即可精确命中目标对比度；
//!   3. 色相稳定 —— 不会像 HSL 那样在明度变化时把色相带跑偏。
//!
//! 参考：Björn Ottosson, "A perceptual color space for image processing" (2020)。

/// sRGB 颜色，分量域 0..1（带 gamma，即屏幕值）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

/// OKLab 颜色。L 感知明度 0..1，a/b 为绿-红 / 蓝-黄对立轴
#[derive(Clone, Copy, Debug)]
pub struct Lab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

impl Rgb {
    pub const fn new(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b }
    }
    pub fn gray(v: f32) -> Self {
        Self { r: v, g: v, b: v }
    }
}

// ---------------------------------------------------------------- 传递函数

pub fn srgb_to_lin(c: f32) -> f32 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub fn lin_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

// ---------------------------------------------------------------- 文本互转

/// 解析 `#rgb` / `#rrggbb` / `rrggbb` / `#rrggbbaa`（忽略 alpha）
pub fn hex_to_rgb(s: &str) -> Option<Rgb> {
    let h = s.trim().trim_start_matches('#');
    let full: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => h.chars().take(6).collect(),
        _ => return None,
    };
    if !full.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(&full, 16).ok()?;
    Some(Rgb::new(
        ((n >> 16) & 0xFF) as f32 / 255.0,
        ((n >> 8) & 0xFF) as f32 / 255.0,
        (n & 0xFF) as f32 / 255.0,
    ))
}

pub fn rgb_to_hex(c: Rgb) -> String {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
    format!("#{:02X}{:02X}{:02X}", q(c.r), q(c.g), q(c.b))
}

// ---------------------------------------------------------------- OKLab

pub fn rgb_to_lab(c: Rgb) -> Lab {
    let r = srgb_to_lin(c.r.clamp(0.0, 1.0));
    let g = srgb_to_lin(c.g.clamp(0.0, 1.0));
    let b = srgb_to_lin(c.b.clamp(0.0, 1.0));

    let l = (0.412_221_47 * r + 0.536_332_54 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();

    Lab {
        l: 0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        a: 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        b: 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    }
}

/// OKLab -> 线性 sRGB（不做裁剪，可能落在 0..1 之外，用于色域判定）
fn lab_to_lin_raw(lab: Lab) -> (f32, f32, f32) {
    let l = (lab.l + 0.396_337_78 * lab.a + 0.215_803_76 * lab.b).powi(3);
    let m = (lab.l - 0.105_561_346 * lab.a - 0.063_854_17 * lab.b).powi(3);
    let s = (lab.l - 0.089_484_18 * lab.a - 1.291_485_5 * lab.b).powi(3);

    (
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    )
}

pub fn lab_in_gamut(lab: Lab) -> bool {
    let (r, g, b) = lab_to_lin_raw(lab);
    const EPS: f32 = 1e-4;
    (-EPS..=1.0 + EPS).contains(&r)
        && (-EPS..=1.0 + EPS).contains(&g)
        && (-EPS..=1.0 + EPS).contains(&b)
}

/// OKLab -> sRGB。超出色域时先降彩度（保 L 与色相），仍不行才硬裁。
/// 直接硬裁会让深色主色泛白/发灰，降彩度是观感上唯一正确的做法。
pub fn lab_to_rgb(lab: Lab) -> Rgb {
    let mut c = lab;
    if !lab_in_gamut(c) {
        let (_, ch, h) = lch(c);
        let mut lo = 0.0f32;
        let mut hi = ch;
        for _ in 0..20 {
            let mid = (lo + hi) * 0.5;
            if lab_in_gamut(from_lch(c.l, mid, h)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        c = from_lch(c.l, lo, h);
    }
    let (r, g, b) = lab_to_lin_raw(c);
    Rgb::new(
        lin_to_srgb(r).clamp(0.0, 1.0),
        lin_to_srgb(g).clamp(0.0, 1.0),
        lin_to_srgb(b).clamp(0.0, 1.0),
    )
}

/// (L, chroma, hue[deg])
pub fn lch(lab: Lab) -> (f32, f32, f32) {
    let ch = (lab.a * lab.a + lab.b * lab.b).sqrt();
    let h = lab.b.atan2(lab.a).to_degrees().rem_euclid(360.0);
    (lab.l, ch, h)
}

pub fn from_lch(l: f32, chroma: f32, hue_deg: f32) -> Lab {
    let r = hue_deg.to_radians();
    Lab {
        l,
        a: chroma * r.cos(),
        b: chroma * r.sin(),
    }
}

// ---------------------------------------------------------------- 对比度

/// WCAG 相对亮度（用线性 sRGB）
pub fn relative_luminance(c: Rgb) -> f32 {
    let r = srgb_to_lin(c.r.clamp(0.0, 1.0));
    let g = srgb_to_lin(c.g.clamp(0.0, 1.0));
    let b = srgb_to_lin(c.b.clamp(0.0, 1.0));
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// WCAG 对比度，1..21。AA 正文 4.5、AAA 正文 7。
pub fn contrast(a: Rgb, b: Rgb) -> f32 {
    let (x, y) = (relative_luminance(a), relative_luminance(b));
    let (hi, lo) = if x > y { (x, y) } else { (y, x) };
    (hi + 0.05) / (lo + 0.05)
}

/// 在给定色相/彩度下，二分求「刚好吃到 target 对比度」的明度。
///
/// 前提：固定 a/b 时对比度对 L 单调 —— OKLab 满足这一点，所以二分成立。
/// `lighter=true` 表示往亮端找（深底上的浅字），false 表示往暗端找。
pub fn at_contrast(bg: Rgb, hue_deg: f32, chroma: f32, target: f32, lighter: bool) -> Lab {
    let bg_l = rgb_to_lab(bg).l;
    let probe = |l: f32| contrast(lab_to_rgb(from_lch(l, chroma, hue_deg)), bg);

    let (lo, hi) = if lighter { (bg_l, 1.0f32) } else { (0.0f32, bg_l) };
    // 两端都不达标就给能拿到的最好结果
    if lighter && probe(1.0) < target {
        return from_lch(1.0, chroma, hue_deg);
    }
    if !lighter && probe(0.0) < target {
        return from_lch(0.0, chroma, hue_deg);
    }

    // 二分不变量：
    //   lighter=true  —— a 在「不达标」的低端，b 在「达标」的高端，收敛到最小可行 L
    //   lighter=false —— a 在「达标」的低端，b 在「不达标」的高端，收敛到最大可行 L
    // 即：达标一侧究竟是 a 还是 b，取决于方向（!lighter）。
    let (mut a, mut b) = (lo, hi);
    for _ in 0..32 {
        let mid = (a + b) * 0.5;
        if (probe(mid) >= target) == !lighter {
            a = mid;
        } else {
            b = mid;
        }
    }
    from_lch((a + b) * 0.5, chroma, hue_deg)
}

/// 在浅色/深色两个候选里挑与 `bg` 对比度更高的那个
pub fn best_on(bg: Rgb) -> Rgb {
    let dark = Rgb::gray(0.0);
    let light = Rgb::gray(1.0);
    if contrast(bg, dark) >= contrast(bg, light) {
        dark
    } else {
        light
    }
}
