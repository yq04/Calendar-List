//! 壁纸取色：采样 -> OKLab k-means 量化 -> 图像特征统计。
//!
//! 这里是「壁纸主题引擎」的前半段，只负责把一张图变成一堆可解释的特征
//! （主色簇、明暗、彩度峰值、暖色倾向），语义映射交给 theme.rs。
//!
//! 两个关键设计：
//!   * **区域加权**：面板是半透明的，真正透出来的是「面板背后那块壁纸」。
//!     所以给面板所占矩形内的像素更高权重，取色结果才会和窗口所在位置协调。
//!   * **降采样到 224px 后再算**：壁纸 4K 也就几十万像素，缩到这个尺寸后
//!     取色结果几乎不变，但耗时从几百毫秒降到几毫秒。

use crate::color::{self, Lab, Rgb};
use image::DynamicImage;

/// 一个颜色簇
#[derive(Clone, Copy, Debug)]
pub struct Cluster {
    pub lab: Lab,
    /// 加权后的面积占比（0..1）
    pub share: f32,
    pub color: Rgb,
}

/// 图像特征分析结果
#[derive(Debug, Clone)]
pub struct Analysis {
    /// 按占比降序
    pub clusters: Vec<Cluster>,
    /// 全图无加权平均明度
    pub ambient_l: f32,
    /// 面板区域加权平均明度（决定明暗模式）
    pub region_l: f32,
    /// 高彩度簇里的彩度峰值（判断是不是灰度壁纸）
    pub max_chroma: f32,
    /// 暖色簇的色相（周末/节假日色的取材来源）
    pub warm_hue: Option<f32>,
    pub sampled: usize,
}

#[derive(Clone, Debug)]
pub struct SampleOpts {
    /// 量化簇数。8 是经验值：再少会丢掉点缀色，再多会开始把同一色拆成几簇。
    pub k: usize,
    /// 面板在壁纸上的归一化矩形 (x0, y0, x1, y1)，None 表示不加权
    pub region: Option<(f32, f32, f32, f32)>,
    /// 落在面板区域内的像素权重倍数
    pub region_boost: f32,
}

impl Default for SampleOpts {
    fn default() -> Self {
        Self {
            k: 8,
            region: None,
            region_boost: 4.0,
        }
    }
}

// ---------------------------------------------------------------- 载入

pub fn load_rgba(path: &str, max_side: u32) -> Result<image::RgbaImage, String> {
    let img = image::open(path).map_err(|e| format!("解码失败 {path}: {e}"))?;
    Ok(downscale(&img, max_side.max(32)))
}

fn downscale(img: &DynamicImage, n: u32) -> image::RgbaImage {
    if img.width() <= n && img.height() <= n {
        return img.to_rgba8();
    }
    // thumbnail 是整数盒式采样，比 resize 快一个量级，取色用完全够
    img.thumbnail(n, n).to_rgba8()
}

// ---------------------------------------------------------------- 采样

/// 把像素转成 OKLab 样本，并附带区域权重
fn sample(rgba: &image::RgbaImage, opts: &SampleOpts) -> Vec<(Lab, f32)> {
    let (w, h) = (rgba.width() as f32, rgba.height() as f32);
    let mut out = Vec::with_capacity((w * h) as usize);

    for (x, y, px) in rgba.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        if a < 128 {
            continue; // 透明区域不参与取色
        }
        let c = Rgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);

        let mut weight = 1.0f32;
        if let Some((x0, y0, x1, y1)) = opts.region {
            let nx = (x as f32 + 0.5) / w;
            let ny = (y as f32 + 0.5) / h;
            if nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1 {
                weight = opts.region_boost.max(1.0);
            }
        }
        out.push((color::rgb_to_lab(c), weight));
    }
    out
}

// ---------------------------------------------------------------- k-means

struct Lcg(u64);

impl Lcg {
    fn next_f32(&mut self) -> f32 {
        // 固定种子的 LCG：同一张壁纸每次生成的主题都一样，便于复现与回归
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 40) as f32) / ((1u32 << 24) as f32)
    }
}

fn dist2(a: Lab, b: Lab) -> f32 {
    let dl = a.l - b.l;
    let da = a.a - b.a;
    let db = a.b - b.b;
    dl * dl + da * da + db * db
}

/// 加权 k-means（k-means++ 初始化）
fn kmeans(samples: &[(Lab, f32)], k: usize) -> Vec<(Lab, f32)> {
    if samples.is_empty() {
        return Vec::new();
    }
    let k = k.min(samples.len());
    let total: f32 = samples.iter().map(|s| s.1).sum();
    if total <= 0.0 {
        return Vec::new();
    }

    let mut rng = Lcg(0x5EED_CA1E_u64);
    let mut centroids: Vec<Lab> = Vec::with_capacity(k);

    // --- k-means++ 初始化 ---
    // 第一个中心按权重随机
    let mut acc = 0.0;
    let pick = rng.next_f32() * total;
    let mut first = samples[0].0;
    for (lab, w) in samples {
        acc += w;
        if acc >= pick {
            first = *lab;
            break;
        }
    }
    centroids.push(first);

    let mut d2: Vec<f32> = samples.iter().map(|(l, _)| dist2(*l, first)).collect();
    for _ in 1..k {
        let sum: f32 = samples.iter().zip(&d2).map(|((_, w), d)| w * d).sum();
        if sum <= f32::EPSILON {
            break;
        }
        let target = rng.next_f32() * sum;
        let mut acc = 0.0;
        let mut chosen = 0usize;
        for (i, ((_, w), d)) in samples.iter().zip(&d2).enumerate() {
            acc += w * d;
            if acc >= target {
                chosen = i;
                break;
            }
        }
        let c = samples[chosen].0;
        centroids.push(c);
        for (i, (lab, _)) in samples.iter().enumerate() {
            let nd = dist2(*lab, c);
            if nd < d2[i] {
                d2[i] = nd;
            }
        }
    }

    // --- Lloyd 迭代 ---
    let mut assign = vec![0usize; samples.len()];
    for _ in 0..12 {
        let mut moved = false;
        for (i, (lab, _)) in samples.iter().enumerate() {
            let mut best = 0usize;
            let mut bd = f32::MAX;
            for (ci, c) in centroids.iter().enumerate() {
                let d = dist2(*lab, *c);
                if d < bd {
                    bd = d;
                    best = ci;
                }
            }
            if assign[i] != best {
                assign[i] = best;
                moved = true;
            }
        }

        let mut sum = vec![(0.0f32, 0.0f32, 0.0f32, 0.0f32); centroids.len()];
        for (i, (lab, w)) in samples.iter().enumerate() {
            let s = &mut sum[assign[i]];
            s.0 += w;
            s.1 += lab.l * w;
            s.2 += lab.a * w;
            s.3 += lab.b * w;
        }
        for (ci, c) in centroids.iter_mut().enumerate() {
            let s = sum[ci];
            if s.0 > 0.0 {
                *c = Lab {
                    l: s.1 / s.0,
                    a: s.2 / s.0,
                    b: s.3 / s.0,
                };
            }
        }
        if !moved {
            break;
        }
    }

    // --- 汇总簇权重 ---
    let mut weights = vec![0.0f32; centroids.len()];
    for (i, (_, w)) in samples.iter().enumerate() {
        weights[assign[i]] += w;
    }
    let mut out: Vec<(Lab, f32)> = centroids
        .iter()
        .zip(&weights)
        .filter(|(_, w)| **w > 0.0)
        .map(|(c, w)| (*c, *w / total))
        .collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

// ---------------------------------------------------------------- 分析入口

pub fn analyze(rgba: &image::RgbaImage, opts: &SampleOpts) -> Analysis {
    let samples = sample(rgba, opts);

    let total: f32 = samples.iter().map(|s| s.1).sum();
    let sum_l: f32 = samples.iter().map(|(l, w)| l.l * w).sum();
    let region_l = if total > 0.0 { sum_l / total } else { 0.5 };
    let ambient_l = if samples.is_empty() {
        0.5
    } else {
        samples.iter().map(|(l, _)| l.l).sum::<f32>() / samples.len() as f32
    };

    let raw = kmeans(&samples, opts.k);
    let clusters: Vec<Cluster> = raw
        .iter()
        .map(|(lab, share)| Cluster {
            lab: *lab,
            share: *share,
            color: color::lab_to_rgb(*lab),
        })
        .collect();

    // 彩度峰值只在「有面积」的簇里找，避免一个孤立的高饱和像素带偏强调色
    let max_chroma = clusters
        .iter()
        .filter(|c| c.share >= 0.02)
        .map(|c| color::lch(c.lab).1)
        .fold(0.0f32, f32::max);

    let mut warm_hue = None;
    let mut warm_score = 0.0f32;
    for c in &clusters {
        let (_, ch, h) = color::lch(c.lab);
        if !(10.0..=75.0).contains(&h) || ch < 0.05 || c.share < 0.01 {
            continue;
        }
        let score = ch * c.share.sqrt();
        if score > warm_score {
            warm_score = score;
            warm_hue = Some(h);
        }
    }

    Analysis {
        clusters,
        ambient_l,
        region_l,
        max_chroma,
        warm_hue,
        sampled: samples.len(),
    }
}

/// 明暗模式判定：看「面板背后那块壁纸」的明度。
/// 阈值 0.55 —— 略高于中位，因为实心浅色面板比深色面板更容易在照片壁纸上显脏。
pub fn decide_mode(region_l: f32) -> &'static str {
    if region_l >= 0.55 {
        "light"
    } else {
        "dark"
    }
}

// ---------------------------------------------------------------- 位置映射

/// 把「窗口在屏幕上的矩形」映射为「壁纸图片内的归一化矩形」。
///
/// 为什么需要它：面板是半透明的，真正透出来的是**面板背后那块壁纸**。
/// 用整张图的平均色，面板放在画面暗处却按亮处配色，就会格格不入。
///
/// 假设壁纸以「填充（cover）」方式铺在窗口所在显示器上 —— 这是 Windows 的默认行为
/// （WallpaperStyle = 10）。「适应 / 平铺 / 居中」等其它样式下本映射会有偏差，
/// 属于已知近似；多显示器跨屏壁纸同理。
///
/// * `win` 窗口矩形（物理像素）：x, y, w, h
/// * `mon` 显示器矩形（物理像素）：left, top, right, bottom
/// * `wp`  壁纸图片尺寸：w, h
pub fn map_window_to_wallpaper(
    win: (i32, i32, u32, u32),
    mon: [i32; 4],
    wp: (u32, u32),
) -> Option<(f32, f32, f32, f32)> {
    let (mw, mh) = ((mon[2] - mon[0]) as f32, (mon[3] - mon[1]) as f32);
    let (ww, wh) = (wp.0 as f32, wp.1 as f32);
    if mw <= 0.0 || mh <= 0.0 || ww <= 0.0 || wh <= 0.0 {
        return None;
    }

    // cover：等比放大到刚好铺满显示器，多余部分居中裁掉
    let scale = (ww / mw).max(wh / mh);
    let (dw, dh) = (ww / scale, wh / scale); // 壁纸在显示器上实际占的像素尺寸
    let (ox, oy) = ((mw - dw) * 0.5, (mh - dh) * 0.5); // 居中偏移

    let to_wp = |mx: f32, my: f32| -> (f32, f32) {
        ((mx - ox) / dw, (my - oy) / dh)
    };

    // 窗口矩形转成「相对显示器」的坐标
    let x0 = (win.0 - mon[0]) as f32;
    let y0 = (win.1 - mon[1]) as f32;
    let x1 = x0 + win.2 as f32;
    let y1 = y0 + win.3 as f32;

    let (nx0, ny0) = to_wp(x0, y0);
    let (nx1, ny1) = to_wp(x1, y1);

    let c = |v: f32| v.clamp(0.0, 1.0);
    let rect = (c(nx0), c(ny0), c(nx1), c(ny1));
    // 退化成一个点或负面积时视为无效
    if rect.2 - rect.0 < 0.01 || rect.3 - rect.1 < 0.01 {
        return None;
    }
    Some(rect)
}
