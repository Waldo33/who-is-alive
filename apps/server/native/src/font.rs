//! Шрифт фильма — Press Start 2P из двух woff (кириллица и латиница с цифрами), как в
//! `film-render.ts`: буква берётся из первого файла, где она есть. Пиксельный шрифт на кегле,
//! кратном 8, растрируется ровно в квадраты — сглаживание тогда не даёт полутонов.

use std::collections::HashMap;

pub struct Glyph {
    pub x: i64,
    pub y: i64,
    pub w: usize,
    pub h: usize,
    pub cov: std::rc::Rc<Vec<u8>>,
}

struct Raster {
    xmin: i32,
    ymin: i32,
    w: usize,
    h: usize,
    adv: f32,
    cov: std::rc::Rc<Vec<u8>>,
}

/// Вертикальные метрики строки (в пикселях): где базовая линия относительно y для `textBaseline`.
pub struct Line {
    pub top: f64,
    pub middle: f64,
    pub bottom: f64,
}

pub struct Fonts {
    fonts: Vec<fontdue::Font>,
    cache: HashMap<(char, u32), Option<(usize, Raster)>>,
}

/// WOFF 1.0 → обычный sfnt (TTF/OTF): таблицы распаковываются zlib.
pub fn woff_to_sfnt(b: &[u8]) -> Result<Vec<u8>, String> {
    let be32 = |o: usize| -> Result<u32, String> {
        b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or("woff: обрезан".to_string())
    };
    let be16 = |o: usize| -> Result<u16, String> { b.get(o..o + 2).map(|s| u16::from_be_bytes([s[0], s[1]])).ok_or("woff: обрезан".to_string()) };
    if b.get(0..4) != Some(b"wOFF") {
        // уже sfnt
        return Ok(b.to_vec());
    }
    let flavor = be32(4)?;
    let n = be16(12)? as usize;
    let mut tables = Vec::with_capacity(n);
    for i in 0..n {
        let e = 44 + i * 20;
        let tag = be32(e)?;
        let off = be32(e + 4)? as usize;
        let comp = be32(e + 8)? as usize;
        let orig = be32(e + 12)? as usize;
        let sum = be32(e + 16)?;
        let raw = b.get(off..off + comp).ok_or("woff: таблица за концом файла")?;
        let data = if comp < orig {
            miniz_oxide::inflate::decompress_to_vec_zlib(raw).map_err(|e| format!("woff: zlib {e:?}"))?
        } else {
            raw.to_vec()
        };
        tables.push((tag, sum, data));
    }
    let mut out = Vec::new();
    let mut p = 1u16;
    let mut lg = 0u16;
    while (p as usize) * 2 <= n {
        p *= 2;
        lg += 1;
    }
    let range = p * 16;
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&(n as u16).to_be_bytes());
    out.extend_from_slice(&range.to_be_bytes());
    out.extend_from_slice(&lg.to_be_bytes());
    out.extend_from_slice(&((n as u16) * 16 - range).to_be_bytes());
    let mut off = 12 + n * 16;
    let mut body = Vec::new();
    for (tag, sum, data) in &tables {
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&sum.to_be_bytes());
        out.extend_from_slice(&(off as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        body.extend_from_slice(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
        off = 12 + n * 16 + body.len();
    }
    out.extend_from_slice(&body);
    Ok(out)
}

impl Fonts {
    pub fn new(files: &[&[u8]]) -> Result<Fonts, String> {
        let mut fonts = Vec::new();
        for f in files {
            let sfnt = woff_to_sfnt(f)?;
            let font = fontdue::Font::from_bytes(sfnt, fontdue::FontSettings { scale: 64.0, ..Default::default() }).map_err(|e| e.to_string())?;
            fonts.push(font);
        }
        if fonts.is_empty() {
            return Err("нет шрифтов".into());
        }
        Ok(Fonts { fonts, cache: HashMap::new() })
    }

    fn glyph(&mut self, ch: char, px: f64) -> Option<&(usize, Raster)> {
        let key = (ch, px.to_bits() as u32 ^ (px.to_bits() >> 32) as u32);
        if !self.cache.contains_key(&key) {
            let found = self.fonts.iter().position(|f| f.lookup_glyph_index(ch) != 0);
            let v = found.map(|i| {
                let (m, cov) = self.fonts[i].rasterize(ch, px as f32);
                (i, Raster { xmin: m.xmin, ymin: m.ymin, w: m.width, h: m.height, adv: m.advance_width, cov: std::rc::Rc::new(cov) })
            });
            self.cache.insert(key, v);
        }
        self.cache.get(&key).and_then(|v| v.as_ref())
    }

    /// Ширина строки (measureText().width): сумма продвижений; буквы без глифа — по кеглю.
    pub fn measure(&mut self, s: &str, px: f64) -> f64 {
        s.chars().map(|ch| self.glyph(ch, px).map(|g| g.1.adv as f64).unwrap_or(px)).sum()
    }

    /// Метрики строки по первому шрифту (у обоих кусков Press Start 2P они одинаковы).
    pub fn line(&self, px: f64) -> Line {
        let m = self.fonts[0].horizontal_line_metrics(px as f32);
        let (asc, desc) = m.map(|m| (m.ascent as f64, m.descent as f64)).unwrap_or((px, 0.0));
        // Skia (старый рендер, браузеры) ставит верх строки на один пиксель шрифта ниже
        // hhea-ascent Press Start 2P: сверено по кадрам фильма (кегли 16 и 24 — сдвиг ровно px/8)
        let top = asc - px / 8.0;
        Line { top, middle: (top + desc) / 2.0, bottom: desc }
    }

    /// Разложить строку на глифы: x0 — левый край, base — базовая линия (в пикселях холста).
    pub fn layout(&mut self, s: &str, px: f64, x0: f64, base: f64) -> Vec<Glyph> {
        let mut pen = x0;
        let mut out = Vec::new();
        for ch in s.chars() {
            let Some((_, g)) = self.glyph(ch, px) else {
                pen += px;
                continue;
            };
            let x = pen.round() as i64 + g.xmin as i64;
            let y = base.round() as i64 - (g.ymin as i64 + g.h as i64);
            if g.w > 0 && g.h > 0 {
                out.push(Glyph { x, y, w: g.w, h: g.h, cov: g.cov.clone() });
            }
            pen += g.adv as f64;
        }
        out
    }
}
