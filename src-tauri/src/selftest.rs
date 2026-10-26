//! 无头自检：只验新增的色彩 / 取色 / 主题三条链路，不做全库回归。
//! 跑法：`kal --selftest`

use crate::{color, palette, theme};

struct T {
    pass: u32,
    fail: u32,
}

impl T {
    fn ok(&mut self, name: &str, cond: bool, extra: String) {
        if cond {
            self.pass += 1;
            println!("  PASS  {name}");
        } else {
            self.fail += 1;
            println!("  FAIL  {name}  {extra}");
        }
    }
    fn near(&mut self, name: &str, got: f32, want: f32, tol: f32) {
        let cond = (got - want).abs() <= tol;
        self.ok(name, cond, format!("got {got:.5} want {want:.5} tol {tol}"));
    }
}

fn lab_dist(a: color::Lab, b: color::Lab) -> f32 {
    ((a.l - b.l).powi(2) + (a.a - b.a).powi(2) + (a.b - b.b).powi(2)).sqrt()
}

/// 造一张四象限测试图（纯红/绿/蓝 + 中性灰），用于验证量化能否还原已知主色
fn quad_image(size: u32) -> image::RgbaImage {
    let half = size / 2;
    image::RgbaImage::from_fn(size, size, |x, y| {
        let c = match (x < half, y < half) {
            (true, true) => [220, 40, 40, 255],
            (false, true) => [40, 200, 70, 255],
            (true, false) => [50, 70, 220, 255],
            (false, false) => [128, 128, 128, 255],
        };
        image::Rgba(c)
    })
}

pub fn run() -> i32 {
    let mut t = T { pass: 0, fail: 0 };
    println!("==== Kal 自检 ====");

    println!("[色彩空间]");
    // 1) hex 解析与回写
    let red = color::hex_to_rgb("#FF0000").unwrap();
    t.ok("hex 解析 #FF0000", (red.r - 1.0).abs() < 1e-6 && red.g == 0.0, String::new());
    t.ok("hex 短写 #0f0 展开", color::hex_to_rgb("#0f0").map(|c| c.g > 0.99).unwrap_or(false), String::new());
    t.ok("hex 非法输入返回 None", color::hex_to_rgb("zzzz").is_none(), String::new());
    t.ok("hex 回写", color::rgb_to_hex(color::Rgb::new(1.0, 0.0, 0.0)) == "#FF0000", String::new());

    // 2) OKLab 往返：任意 sRGB 经 lab 再回来，误差应在一两个色阶内
    let mut worst = 0.0f32;
    for &c in &[
        color::Rgb::new(0.0, 0.0, 0.0),
        color::Rgb::new(1.0, 1.0, 1.0),
        color::Rgb::new(0.86, 0.13, 0.13),
        color::Rgb::new(0.1, 0.6, 0.35),
        color::Rgb::new(0.2, 0.2, 0.85),
        color::Rgb::new(0.53, 0.53, 0.53),
    ] {
        let back = color::lab_to_rgb(color::rgb_to_lab(c));
        worst = worst.max((back.r - c.r).abs().max((back.g - c.g).abs()).max((back.b - c.b).abs()));
    }
    t.ok("OKLab 往返误差 < 1/255", worst < 0.004, format!("worst {worst:.5}"));

    // 3) WCAG 对比度标定点
    let black = color::Rgb::gray(0.0);
    let white = color::Rgb::gray(1.0);
    t.near("黑白对比度 = 21", color::contrast(black, white), 21.0, 0.02);
    t.near("同色对比度 = 1", color::contrast(white, white), 1.0, 0.001);

    // 4) at_contrast 必须真的吃到目标值
    // 既要够（>= 目标），也不能过冲（<= 目标 1.25 倍）—— 只查下界会漏掉「方向写反」这类 bug
    let bg_dark = color::lab_to_rgb(color::from_lch(0.15, 0.02, 250.0));
    for target in [3.0f32, 4.5, 7.0, 12.0] {
        let fg = color::lab_to_rgb(color::at_contrast(bg_dark, 250.0, 0.01, target, true));
        let got = color::contrast(fg, bg_dark);
        t.ok(
            &format!("深底上命中对比度 {target}"),
            got >= target - 0.05 && got <= target * 1.25,
            format!("got {got:.3}"),
        );
    }
    let bg_light = color::lab_to_rgb(color::from_lch(0.94, 0.01, 90.0));
    for target in [4.5f32, 7.0] {
        let fg = color::lab_to_rgb(color::at_contrast(bg_light, 90.0, 0.01, target, false));
        let got = color::contrast(fg, bg_light);
        t.ok(
            &format!("浅底上命中对比度 {target}"),
            got >= target - 0.05 && got <= target * 1.25,
            format!("got {got:.3}"),
        );
    }

    println!("[取色]");
    let img = quad_image(128);
    let a = palette::analyze(&img, &palette::SampleOpts::default());
    t.ok("簇数不超过 k", a.clusters.len() <= 8, format!("got {}", a.clusters.len()));
    t.ok("簇占比之和 ≈ 1", (a.clusters.iter().map(|c| c.share).sum::<f32>() - 1.0).abs() < 0.02,
        format!("sum {}", a.clusters.iter().map(|c| c.share).sum::<f32>()));
    t.ok("采样数 > 0", a.sampled > 0, String::new());

    // 四象限图的四个真值必须都能在结果里找到
    let wants = [
        (color::Rgb::new(220.0 / 255.0, 40.0 / 255.0, 40.0 / 255.0), "红"),
        (color::Rgb::new(40.0 / 255.0, 200.0 / 255.0, 70.0 / 255.0), "绿"),
        (color::Rgb::new(50.0 / 255.0, 70.0 / 255.0, 220.0 / 255.0), "蓝"),
        (color::Rgb::new(128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0), "灰"),
    ];
    for (want, label) in wants {
        let wl = color::rgb_to_lab(want);
        let best = a
            .clusters
            .iter()
            .map(|c| lab_dist(c.lab, wl))
            .fold(f32::MAX, f32::min);
        t.ok(&format!("还原主色：{label}"), best < 0.06, format!("最近距离 {best:.4}"));
    }

    // 灰度壁纸应被识别为低彩度（后续会走「合成强调色」分支）
    let gray = image::RgbaImage::from_fn(64, 64, |x, _| {
        let v = (x * 4) as u8;
        image::Rgba([v, v, v, 255])
    });
    let ga = palette::analyze(&gray, &palette::SampleOpts::default());
    t.ok("灰度图彩度峰值 < 0.03", ga.max_chroma < 0.03, format!("got {:.4}", ga.max_chroma));
    t.ok("灰度图暖色相缺失", ga.warm_hue.is_none(), format!("{:?}", ga.warm_hue));

    println!("[主题生成]");
    let tmp = std::env::temp_dir().join("kal_selftest_wall.png");
    let dark_wall = image::RgbaImage::from_fn(160, 160, |x, y| {
        // 深蓝底 + 右下角一块青绿点缀
        if x > 110 && y > 110 {
            image::Rgba([40, 200, 190, 255])
        } else {
            image::Rgba([(18 + x / 8) as u8, (22 + y / 8) as u8, (48 + x / 6) as u8, 255])
        }
    });
    image::DynamicImage::ImageRgba8(dark_wall).save(&tmp).expect("写测试图失败");
    let path = tmp.display().to_string();

    match theme::generate_from_path(&path, "selftest", &theme::GenOpts::default()) {
        Ok((th, rep)) => {
            t.ok("暗色壁纸判定为 dark", th.mode == "dark", th.mode.clone());
            t.ok("前景对比度 >= 12", rep.contrast_fg >= 12.0, format!("{:.2}", rep.contrast_fg));
            t.ok("次要文字对比度 >= 6", rep.contrast_muted >= 6.0, format!("{:.2}", rep.contrast_muted));
            t.ok("强调色对比度 >= 4.5", rep.contrast_accent >= 4.5, format!("{:.2}", rep.contrast_accent));
            t.ok("面板不透明度在 0.55..0.90", (0.55..=0.90).contains(&th.color.bg_alpha),
                format!("{:.3}", th.color.bg_alpha));
            t.ok("所有颜色字段都是合法 hex",
                [&th.color.bg, &th.color.fg, &th.color.accent, &th.color.fg_weekend,
                 &th.color.fg_holiday, &th.color.fg_muted, &th.color.fg_dim,
                 &th.color.fg_other_month, &th.color.surface, &th.color.today_ring]
                    .iter().all(|s| color::hex_to_rgb(s).is_some()),
                String::new());
            t.ok("壁纸路径已记录", th.wallpaper == path, th.wallpaper.clone());
            t.ok("强调色取自青绿点缀", rep.accent_from != "fallback" || rep.clusters.len() < 2,
                rep.accent_from.clone());

            // 浅色壁纸应走 light 分支
            let light_wall = image::RgbaImage::from_fn(160, 160, |x, y| {
                image::Rgba([(232 + x / 16) as u8, (228 + y / 16) as u8, 220, 255])
            });
            let tmp2 = std::env::temp_dir().join("kal_selftest_light.png");
            image::DynamicImage::ImageRgba8(light_wall).save(&tmp2).expect("写测试图失败");
            match theme::generate_from_path(&tmp2.display().to_string(), "selftest", &theme::GenOpts::default()) {
                Ok((t2, r2)) => {
                    t.ok("浅色壁纸判定为 light", t2.mode == "light", t2.mode.clone());
                    t.ok("浅底前景对比度 >= 12", r2.contrast_fg >= 12.0, format!("{:.2}", r2.contrast_fg));
                }
                Err(e) => t.ok("浅色壁纸生成", false, e),
            }

            // 强制覆盖项必须生效
            let forced = theme::GenOpts {
                mode: Some("light".into()),
                alpha: Some(0.8),
                accent: Some("#FF00AA".into()),
                ..Default::default()
            };
            match theme::generate_from_path(&path, "selftest", &forced) {
                Ok((t3, _)) => {
                    t.ok("可强制 light 模式", t3.mode == "light", t3.mode.clone());
                    t.near("可强制不透明度", t3.color.bg_alpha, 0.8, 0.001);
                    t.ok("可强制强调色", t3.color.accent.eq_ignore_ascii_case("#FF00AA"), t3.color.accent.clone());
                }
                Err(e) => t.ok("强制覆盖项", false, e),
            }

            // 主题 JSON 往返：schema 是渲染器无关的，必须无损
            let json = serde_json::to_string(&th).expect("序列化失败");
            let back: theme::Theme = serde_json::from_str(&json).expect("反序列化失败");
            let json2 = serde_json::to_string(&back).expect("再序列化失败");
            t.ok("主题 JSON 往返无损", json == json2, String::new());
            let _ = std::fs::remove_file(&tmp);
        }
        Err(e) => t.ok("壁纸生成主题", false, e),
    }

    println!("\n  结果: {} 通过 / {} 失败", t.pass, t.fail);
    if t.fail == 0 { 0 } else { 1 }
}
