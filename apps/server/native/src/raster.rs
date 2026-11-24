//! Пиксельный холст: то подмножество Canvas 2D, которым рисуются клип и фильм матча
//! (apps/web/src/game/clip.ts, film.ts, art.ts, sprites.ts, темы).
//!
//! Правила (их проверяют тесты внизу и сверка кадров со старым рендером в apps/server/test):
//! - пиксели хранятся с умноженной альфой (premultiplied RGBA), как в Skia;
//! - сглаживания нет нигде: пиксель закрашен, если его центр внутри фигуры (картинка — пиксель-арт,
//!   все координаты в кадре целые после целочисленного масштаба);
//! - картинка берётся «ближайшим соседом»: пиксель источника под центром пикселя назначения;
//! - смешивание — `source-over`, плюс `source-in` (перекраска спрайта в `art.ts › tint`) и `copy`;
//! - `globalAlpha` умножает и заливку, и картинку;
//! - узор (`createPattern(..., 'repeat')`) повторяется в пространстве пользователя (текущее преобразование).

use crate::font::Fonts;

/// Матрица преобразования как в Canvas: x' = a·x + c·y + e, y' = b·x + d·y + f.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Mat {
    pub const ID: Mat = Mat { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    #[inline]
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }

    /// Только масштаб и сдвиг (без поворота и скоса) — быстрый путь.
    #[inline]
    pub fn axis(&self) -> bool {
        self.b == 0.0 && self.c == 0.0
    }

    pub fn inverse(&self) -> Option<Mat> {
        let det = self.a * self.d - self.b * self.c;
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        let a = self.d / det;
        let b = -self.b / det;
        let c = -self.c / det;
        let d = self.a / det;
        Some(Mat { a, b, c, d, e: -(a * self.e + c * self.f), f: -(b * self.e + d * self.f) })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Comp {
    SrcOver,
    SourceIn,
    Copy,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Paint {
    /// Цвет с умноженной альфой.
    Color(u32),
    /// Узор из холста (id), повтор по обеим осям.
    Pattern(u32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Baseline {
    Top,
    Middle,
    Alphabetic,
    Bottom,
}

/// Состояние контекста на момент операции (его целиком присылает JS — у Rust своего стека нет).
#[derive(Clone, Copy, Debug)]
pub struct State {
    pub m: Mat,
    pub alpha: f64,
    pub comp: Comp,
    pub paint: Paint,
    pub stroke: u32,
    pub line_width: f64,
    pub font_px: f64,
    pub align: Align,
    pub baseline: Baseline,
}

impl Default for State {
    fn default() -> Self {
        State {
            m: Mat::ID,
            alpha: 1.0,
            comp: Comp::SrcOver,
            paint: Paint::Color(premul(0xff00_0000)),
            stroke: premul(0xff00_0000),
            line_width: 1.0,
            font_px: 10.0,
            align: Align::Left,
            baseline: Baseline::Alphabetic,
        }
    }
}

pub struct Surface {
    pub w: u32,
    pub h: u32,
    /// RGBA с умноженной альфой, байты r, g, b, a (младший — r).
    pub px: Vec<u32>,
}

impl Surface {
    pub fn new(w: u32, h: u32) -> Surface {
        Surface { w, h, px: vec![0; (w as usize) * (h as usize)] }
    }
}

/// x·y/255 с округлением, без деления.
#[inline(always)]
pub fn mul255(x: u32, y: u32) -> u32 {
    let t = x * y + 128;
    (t + (t >> 8)) >> 8
}

/// Обычный RGBA (младший байт — r) → с умноженной альфой.
pub fn premul(c: u32) -> u32 {
    let a = c >> 24;
    if a == 255 {
        return c;
    }
    let r = mul255(c & 255, a);
    let g = mul255((c >> 8) & 255, a);
    let b = mul255((c >> 16) & 255, a);
    r | (g << 8) | (b << 16) | (a << 24)
}

/// С умноженной альфой → обычный RGBA (как отдаёт getImageData).
pub fn unpremul(c: u32) -> u32 {
    let a = c >> 24;
    if a == 255 || a == 0 {
        return if a == 0 { 0 } else { c };
    }
    let f = |v: u32| ((v * 255 + a / 2) / a).min(255);
    f(c & 255) | (f((c >> 8) & 255) << 8) | (f((c >> 16) & 255) << 16) | (a << 24)
}

/// Умножить цвет (с умноженной альфой) на покрытие 0..255 — два канала за одно умножение.
#[inline(always)]
fn scale(c: u32, k: u32) -> u32 {
    if k >= 255 {
        return c;
    }
    let rb = (c & 0x00ff_00ff) * k + 0x0080_0080;
    let rb = ((rb + ((rb >> 8) & 0x00ff_00ff)) >> 8) & 0x00ff_00ff;
    let ag = ((c >> 8) & 0x00ff_00ff) * k + 0x0080_0080;
    let ag = (ag + ((ag >> 8) & 0x00ff_00ff)) & 0xff00_ff00;
    rb | ag
}

/// source-over для цветов с умноженной альфой: s + d·(1 − sa). Переполнения нет: каналы ≤ альфы.
#[inline(always)]
fn over(s: u32, d: u32) -> u32 {
    let sa = s >> 24;
    if sa == 255 {
        return s;
    }
    if sa == 0 {
        return d;
    }
    s + scale(d, 255 - sa)
}

/// Смешать источник s (с умноженной альфой, уже умноженный на покрытие) с d.
#[inline(always)]
fn blend(comp: Comp, s: u32, d: u32) -> u32 {
    match comp {
        Comp::SrcOver => over(s, d),
        Comp::SourceIn => scale(s, d >> 24),
        Comp::Copy => s,
    }
}

/// Диапазон пикселей [i0, i1), чьи центры внутри [x0, x1).
#[inline]
fn span(x0: f64, x1: f64, n: u32) -> (i64, i64) {
    let (lo, hi) = if x0 <= x1 { (x0, x1) } else { (x1, x0) };
    let i0 = ((lo - 0.5).ceil() as i64).max(0);
    let i1 = ((hi - 0.5).ceil() as i64).min(n as i64);
    (i0, i1)
}

pub struct Raster {
    surfaces: Vec<Option<Surface>>,
    pub st: State,
    pub target: u32,
    pub fonts: Option<Fonts>,
}

impl Default for Raster {
    fn default() -> Self {
        Self::new()
    }
}

impl Raster {
    pub fn new() -> Raster {
        Raster { surfaces: Vec::new(), st: State::default(), target: 0, fonts: None }
    }

    /// Создать холст или поменять размер (как `canvas.width = …`: содержимое стирается).
    pub fn resize(&mut self, id: u32, w: u32, h: u32) {
        let i = id as usize;
        if self.surfaces.len() <= i {
            self.surfaces.resize_with(i + 1, || None);
        }
        self.surfaces[i] = Some(Surface::new(w, h));
    }

    pub fn free(&mut self, id: u32) {
        if let Some(s) = self.surfaces.get_mut(id as usize) {
            *s = None;
        }
    }

    pub fn surface(&self, id: u32) -> Option<&Surface> {
        self.surfaces.get(id as usize).and_then(|s| s.as_ref())
    }

    fn take_target(&mut self) -> Option<Surface> {
        self.surfaces.get_mut(self.target as usize).and_then(|s| s.take())
    }

    fn put_target(&mut self, s: Surface) {
        self.surfaces[self.target as usize] = Some(s);
    }

    /// Пиксели прямоугольника без умноженной альфы (getImageData); вне холста — прозрачные.
    pub fn read(&self, id: u32, x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
        let Some(s) = self.surface(id) else { return out };
        for j in 0..h as i32 {
            let sy = y + j;
            if sy < 0 || sy >= s.h as i32 {
                continue;
            }
            for i in 0..w as i32 {
                let sx = x + i;
                if sx < 0 || sx >= s.w as i32 {
                    continue;
                }
                let c = unpremul(s.px[(sy as usize) * (s.w as usize) + sx as usize]);
                let o = ((j as usize) * (w as usize) + i as usize) * 4;
                out[o..o + 4].copy_from_slice(&c.to_le_bytes());
            }
        }
        out
    }

    /// Заливка прямоугольника текущим цветом или узором.
    pub fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let st = self.st;
        let pattern = match st.paint {
            Paint::Pattern(id) => self.surface(id).map(|p| (p.w, p.h, p.px.clone())),
            Paint::Color(_) => None,
        };
        let color = match st.paint {
            Paint::Color(c) => c,
            Paint::Pattern(_) if pattern.is_none() => return,
            Paint::Pattern(_) => 0,
        };
        let ga = (st.alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
        if ga == 0 {
            return;
        }
        let inv = match st.m.inverse() {
            Some(m) => m,
            None => return,
        };
        let Some(mut s) = self.take_target() else { return };
        let sw = s.w as usize;
        // цвет пикселя (x, y) холста: узор берётся в пространстве пользователя
        let src = |px: i64, py: i64| -> u32 {
            match &pattern {
                None => color,
                Some((pw, ph, data)) => {
                    let (u, v) = inv.apply(px as f64 + 0.5, py as f64 + 0.5);
                    let iu = (u.floor() as i64).rem_euclid(*pw as i64) as usize;
                    let iv = (v.floor() as i64).rem_euclid(*ph as i64) as usize;
                    data[iv * (*pw as usize) + iu]
                }
            }
        };
        if st.m.axis() {
            let (x0, y0) = st.m.apply(x, y);
            let (x1, y1) = st.m.apply(x + w, y + h);
            let (i0, i1) = span(x0, x1, s.w);
            let (j0, j1) = span(y0, y1, s.h);
            if pattern.is_none() && i0 < i1 {
                // сплошной цвет — самый частый случай: строка целиком
                let c = scale(color, ga);
                for j in j0..j1 {
                    let row = &mut s.px[(j as usize) * sw + i0 as usize..(j as usize) * sw + i1 as usize];
                    match st.comp {
                        Comp::Copy => row.fill(c),
                        Comp::SrcOver if c >> 24 == 255 => row.fill(c),
                        Comp::SrcOver => row.iter_mut().for_each(|d| *d = over(c, *d)),
                        Comp::SourceIn => row.iter_mut().for_each(|d| *d = scale(c, *d >> 24)),
                    }
                }
                self.put_target(s);
                return;
            }
            for j in j0..j1 {
                let row = (j as usize) * sw;
                for i in i0..i1 {
                    let d = &mut s.px[row + i as usize];
                    *d = blend(st.comp, scale(src(i, j), ga), *d);
                }
            }
        } else {
            let corners = [st.m.apply(x, y), st.m.apply(x + w, y), st.m.apply(x, y + h), st.m.apply(x + w, y + h)];
            let (bx0, bx1, by0, by1) = bbox(&corners);
            let (i0, i1) = span(bx0, bx1, s.w);
            let (j0, j1) = span(by0, by1, s.h);
            let (rx0, rx1) = (x.min(x + w), x.max(x + w));
            let (ry0, ry1) = (y.min(y + h), y.max(y + h));
            for j in j0..j1 {
                for i in i0..i1 {
                    let (u, v) = inv.apply(i as f64 + 0.5, j as f64 + 0.5);
                    if u < rx0 || u >= rx1 || v < ry0 || v >= ry1 {
                        continue;
                    }
                    let d = &mut s.px[(j as usize) * sw + i as usize];
                    *d = blend(st.comp, scale(src(i, j), ga), *d);
                }
            }
        }
        self.put_target(s);
    }

    /// Стереть прямоугольник до прозрачного.
    pub fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let saved = self.st;
        self.st.comp = Comp::Copy;
        self.st.alpha = 1.0;
        self.st.paint = Paint::Color(0);
        self.fill_rect(x, y, w, h);
        self.st = saved;
    }

    /// Рамка (`strokeRect`): четыре полосы шириной lineWidth по центру сторон.
    pub fn stroke_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let saved = self.st;
        let lw = self.st.line_width;
        self.st.paint = Paint::Color(self.st.stroke);
        let h2 = lw / 2.0;
        self.fill_rect(x - h2, y - h2, w + lw, lw);
        self.fill_rect(x - h2, y + h - h2, w + lw, lw);
        self.fill_rect(x - h2, y + h2, lw, h - lw);
        self.fill_rect(x + w - h2, y + h2, lw, h - lw);
        self.st = saved;
    }

    /// drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) — ближайший сосед, без сглаживания.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_image(&mut self, src_id: u32, sx: f64, sy: f64, sw: f64, sh: f64, dx: f64, dy: f64, dw: f64, dh: f64) {
        if sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 {
            return;
        }
        let st = self.st;
        let ga = (st.alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
        if ga == 0 {
            return;
        }
        let Some(inv) = st.m.inverse() else { return };
        // картинка на саму себя — рисуем с копии
        let copy;
        let same = src_id == self.target;
        let Some(mut dst) = self.take_target() else { return };
        let src: &Surface = if same {
            copy = Surface { w: dst.w, h: dst.h, px: dst.px.clone() };
            &copy
        } else {
            match self.surfaces.get(src_id as usize).and_then(|s| s.as_ref()) {
                Some(s) => s,
                None => {
                    self.put_target(dst);
                    return;
                }
            }
        };
        // прямоугольник источника, обрезанный по картинке
        let (sx0, sx1) = (sx.min(sx + sw), sx.max(sx + sw));
        let (sy0, sy1) = (sy.min(sy + sh), sy.max(sy + sh));
        let (cx0, cx1) = (sx0.max(0.0), sx1.min(src.w as f64));
        let (cy0, cy1) = (sy0.max(0.0), sy1.min(src.h as f64));
        if cx0 >= cx1 || cy0 >= cy1 {
            self.put_target(dst);
            return;
        }
        let kx = sw / dw;
        let ky = sh / dh;
        let sample_x = |u: f64| -> Option<usize> {
            let v = sx + (u - dx) * kx;
            if v < cx0 || v >= cx1 {
                return None;
            }
            Some(v.floor() as usize)
        };
        let sample_y = |u: f64| -> Option<usize> {
            let v = sy + (u - dy) * ky;
            if v < cy0 || v >= cy1 {
                return None;
            }
            Some(v.floor() as usize)
        };
        let dwid = dst.w as usize;
        let swid = src.w as usize;
        let (dx0, dx1) = (dx.min(dx + dw), dx.max(dx + dw));
        let (dy0, dy1) = (dy.min(dy + dh), dy.max(dy + dh));
        if st.m.axis() {
            let (x0, y0) = st.m.apply(dx0, dy0);
            let (x1, y1) = st.m.apply(dx1, dy1);
            let (i0, i1) = span(x0, x1, dst.w);
            let (j0, j1) = span(y0, y1, dst.h);
            if i0 >= i1 || j0 >= j1 {
                self.put_target(dst);
                return;
            }
            // столбцы источника для каждого столбца назначения — один раз
            const NONE: u32 = u32::MAX;
            let cols: Vec<u32> = (i0..i1)
                .map(|i| {
                    let u = (i as f64 + 0.5 - st.m.e) / st.m.a;
                    if u < dx0 || u >= dx1 {
                        NONE
                    } else {
                        sample_x(u).map(|v| v as u32).unwrap_or(NONE)
                    }
                })
                .collect();
            // строка, целиком закрытая непрозрачными пикселями источника, не зависит от того, что под ней:
            // при растяжке ×k следующие k−1 строк с той же строкой источника — просто копия
            let mut prev: Option<(usize, usize)> = None;
            for j in j0..j1 {
                let v = (j as f64 + 0.5 - st.m.f) / st.m.d;
                if v < dy0 || v >= dy1 {
                    continue;
                }
                let Some(syi) = sample_y(v) else { continue };
                let (r0, r1) = ((j as usize) * dwid + i0 as usize, (j as usize) * dwid + i1 as usize);
                if let Some((psy, pr0)) = prev {
                    if psy == syi {
                        dst.px.copy_within(pr0..pr0 + (r1 - r0), r0);
                        continue;
                    }
                }
                prev = None;
                let srow = &src.px[syi * swid..syi * swid + swid];
                let drow = &mut dst.px[r0..r1];
                if st.comp == Comp::SrcOver && ga == 255 {
                    let mut solid = true;
                    for (d, &sxi) in drow.iter_mut().zip(cols.iter()) {
                        if sxi == NONE {
                            solid = false;
                            continue;
                        }
                        let s = srow[sxi as usize];
                        let a = s >> 24;
                        if a == 255 {
                            *d = s;
                        } else {
                            solid = false;
                            if a != 0 {
                                *d = s + scale(*d, 255 - a);
                            }
                        }
                    }
                    if solid {
                        prev = Some((syi, r0));
                    }
                } else {
                    for (d, &sxi) in drow.iter_mut().zip(cols.iter()) {
                        if sxi == NONE {
                            continue;
                        }
                        *d = blend(st.comp, scale(srow[sxi as usize], ga), *d);
                    }
                }
            }
        } else {
            let corners = [st.m.apply(dx0, dy0), st.m.apply(dx1, dy0), st.m.apply(dx0, dy1), st.m.apply(dx1, dy1)];
            let (bx0, bx1, by0, by1) = bbox(&corners);
            let (i0, i1) = span(bx0, bx1, dst.w);
            let (j0, j1) = span(by0, by1, dst.h);
            for j in j0..j1 {
                for i in i0..i1 {
                    let (u, v) = inv.apply(i as f64 + 0.5, j as f64 + 0.5);
                    if u < dx0 || u >= dx1 || v < dy0 || v >= dy1 {
                        continue;
                    }
                    let (Some(sxi), Some(syi)) = (sample_x(u), sample_y(v)) else { continue };
                    let s = src.px[syi * swid + sxi];
                    let d = &mut dst.px[(j as usize) * dwid + i as usize];
                    *d = blend(st.comp, scale(s, ga), *d);
                }
            }
        }
        self.put_target(dst);
    }

    /// fillText: шрифт Press Start 2P, кегль — из состояния; поворот текста не поддерживается
    /// (в фильме его нет), масштаб преобразования умножает кегль.
    pub fn fill_text(&mut self, s: &str, x: f64, y: f64) {
        let st = self.st;
        let Paint::Color(color) = st.paint else { return };
        let ga = (st.alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
        if ga == 0 {
            return;
        }
        let Some(fonts) = self.fonts.as_mut() else { return };
        let sc = st.m.a.abs().max(1e-9);
        let px = st.font_px * sc;
        let width = fonts.measure(s, px);
        let (ox, oy) = st.m.apply(x, y);
        let x0 = match st.align {
            Align::Left => ox,
            Align::Center => ox - width / 2.0,
            Align::Right => ox - width,
        };
        let m = fonts.line(px);
        let base = match st.baseline {
            Baseline::Top => oy + m.top,
            Baseline::Middle => oy + m.middle,
            Baseline::Alphabetic => oy,
            Baseline::Bottom => oy + m.bottom,
        };
        let glyphs = fonts.layout(s, px, x0, base);
        let Some(mut dst) = self.take_target() else { return };
        let c = scale(color, ga);
        let dw = dst.w as i64;
        let dh = dst.h as i64;
        for g in glyphs {
            for gy in 0..g.h as i64 {
                let yy = g.y + gy;
                if yy < 0 || yy >= dh {
                    continue;
                }
                for gx in 0..g.w as i64 {
                    let xx = g.x + gx;
                    if xx < 0 || xx >= dw {
                        continue;
                    }
                    let cov = g.cov[(gy as usize) * g.w + gx as usize] as u32;
                    if cov == 0 {
                        continue;
                    }
                    let d = &mut dst.px[(yy as usize) * (dw as usize) + xx as usize];
                    *d = blend(st.comp, scale(c, cov), *d);
                }
            }
        }
        self.put_target(dst);
    }
}

fn bbox(p: &[(f64, f64); 4]) -> (f64, f64, f64, f64) {
    let mut r = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(x, y) in p {
        r.0 = r.0.min(x);
        r.1 = r.1.max(x);
        r.2 = r.2.min(y);
        r.3 = r.3.max(y);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: u32 = 0xff00_00ff;
    const BLUE: u32 = 0xffff_0000;

    fn ras(w: u32, h: u32) -> Raster {
        let mut r = Raster::new();
        r.resize(0, w, h);
        r.target = 0;
        r
    }
    fn at(r: &Raster, id: u32, x: u32, y: u32) -> u32 {
        let s = r.surface(id).unwrap();
        s.px[(y * s.w + x) as usize]
    }

    #[test]
    fn fill_rect_covers_pixel_centres_only() {
        let mut r = ras(8, 8);
        r.st.paint = Paint::Color(RED);
        r.fill_rect(1.0, 1.0, 2.0, 3.0);
        let n = r.surface(0).unwrap().px.iter().filter(|&&c| c == RED).count();
        assert_eq!(n, 6);
        assert_eq!(at(&r, 0, 1, 1), RED);
        assert_eq!(at(&r, 0, 3, 1), 0);
        // половина пикселя: центр 0.5 не внутри [0.6, 1.4) — пусто; [0.4, 1.4) — закрашен один
        let mut r = ras(4, 1);
        r.st.paint = Paint::Color(RED);
        r.fill_rect(0.6, 0.0, 0.8, 1.0);
        assert_eq!(r.surface(0).unwrap().px.iter().filter(|&&c| c != 0).count(), 0);
        r.fill_rect(0.4, 0.0, 1.0, 1.0);
        assert_eq!(r.surface(0).unwrap().px.iter().filter(|&&c| c != 0).count(), 1);
    }

    #[test]
    fn integer_scale_makes_square_pixels() {
        let mut r = ras(9, 9);
        r.st.m = Mat { a: 3.0, d: 3.0, ..Mat::ID };
        r.st.paint = Paint::Color(RED);
        r.fill_rect(1.0, 1.0, 1.0, 1.0);
        for y in 0..9 {
            for x in 0..9 {
                let inside = (3..6).contains(&x) && (3..6).contains(&y);
                assert_eq!(at(&r, 0, x, y) == RED, inside, "{x},{y}");
            }
        }
    }

    #[test]
    fn global_alpha_blends_over() {
        let mut r = ras(1, 1);
        r.st.paint = Paint::Color(BLUE);
        r.fill_rect(0.0, 0.0, 1.0, 1.0);
        r.st.paint = Paint::Color(RED);
        r.st.alpha = 0.5;
        r.fill_rect(0.0, 0.0, 1.0, 1.0);
        let c = at(&r, 0, 0, 0);
        assert_eq!(c >> 24, 255);
        assert!(((c & 255) as i32 - 128).abs() <= 1);
        assert!((((c >> 16) & 255) as i32 - 127).abs() <= 1);
    }

    #[test]
    fn premul_roundtrip() {
        for c in [0x80ff_8040u32, 0xff12_3456, 0x0000_0000, 0x40ff_ffff] {
            let back = unpremul(premul(c));
            for k in 0..4 {
                let (a, b) = ((c >> (k * 8)) & 255, (back >> (k * 8)) & 255);
                assert!((a as i32 - b as i32).abs() <= 4, "{c:08x} -> {back:08x}");
            }
        }
    }

    #[test]
    fn draw_image_nearest_scaled_and_flipped() {
        let mut r = Raster::new();
        r.resize(1, 2, 1);
        r.target = 1;
        r.st.paint = Paint::Color(RED);
        r.fill_rect(0.0, 0.0, 1.0, 1.0);
        r.st.paint = Paint::Color(BLUE);
        r.fill_rect(1.0, 0.0, 1.0, 1.0);
        r.resize(0, 8, 2);
        r.target = 0;
        r.st = State::default();
        // ×2
        r.draw_image(1, 0.0, 0.0, 2.0, 1.0, 0.0, 0.0, 4.0, 2.0);
        assert_eq!([0, 1, 2, 3].map(|x| at(&r, 0, x, 1)), [RED, RED, BLUE, BLUE]);
        // зеркально: translate(8, 0) scale(-1, 1)
        r.st.m = Mat { a: -1.0, e: 8.0, ..Mat::ID };
        r.draw_image(1, 0.0, 0.0, 2.0, 1.0, 0.0, 0.0, 2.0, 1.0);
        assert_eq!([6, 7].map(|x| at(&r, 0, x, 0)), [BLUE, RED]);
    }

    #[test]
    fn draw_image_sub_rect_and_transparent_skip() {
        let mut r = Raster::new();
        r.resize(1, 4, 1);
        r.target = 1;
        r.st.paint = Paint::Color(RED);
        r.fill_rect(2.0, 0.0, 1.0, 1.0);
        r.resize(0, 2, 1);
        r.target = 0;
        r.st = State::default();
        r.st.paint = Paint::Color(BLUE);
        r.fill_rect(0.0, 0.0, 2.0, 1.0);
        r.draw_image(1, 2.0, 0.0, 2.0, 1.0, 0.0, 0.0, 2.0, 1.0);
        assert_eq!([at(&r, 0, 0, 0), at(&r, 0, 1, 0)], [RED, BLUE]);
    }

    #[test]
    fn rotation_quarter_turn() {
        let mut r = Raster::new();
        r.resize(1, 3, 1);
        r.target = 1;
        r.st.paint = Paint::Color(RED);
        r.fill_rect(0.0, 0.0, 3.0, 1.0);
        r.resize(0, 5, 5);
        r.target = 0;
        r.st = State::default();
        // translate(2.5, 2.5) rotate(90°): полоска 3×1 встаёт вертикально
        r.st.m = Mat { a: 0.0, b: 1.0, c: -1.0, d: 0.0, e: 2.5, f: 2.5 };
        r.draw_image(1, 0.0, 0.0, 3.0, 1.0, -1.5, -0.5, 3.0, 1.0);
        let lit: Vec<(u32, u32)> = (0..5).flat_map(|y| (0..5).map(move |x| (x, y))).filter(|&(x, y)| at(&r, 0, x, y) == RED).collect();
        assert_eq!(lit, vec![(2, 1), (2, 2), (2, 3)]);
    }

    #[test]
    fn source_in_tints_opaque_pixels() {
        let mut r = ras(2, 1);
        r.st.paint = Paint::Color(RED);
        r.fill_rect(0.0, 0.0, 1.0, 1.0);
        r.st.comp = Comp::SourceIn;
        r.st.paint = Paint::Color(BLUE);
        r.fill_rect(0.0, 0.0, 2.0, 1.0);
        assert_eq!([at(&r, 0, 0, 0), at(&r, 0, 1, 0)], [BLUE, 0]);
    }

    #[test]
    fn pattern_repeats_in_user_space() {
        let mut r = Raster::new();
        r.resize(1, 2, 1);
        r.target = 1;
        r.st.paint = Paint::Color(RED);
        r.fill_rect(0.0, 0.0, 1.0, 1.0);
        r.resize(0, 5, 1);
        r.target = 0;
        r.st = State::default();
        r.st.paint = Paint::Pattern(1);
        r.fill_rect(0.0, 0.0, 5.0, 1.0);
        assert_eq!((0..5).map(|x| at(&r, 0, x, 0) == RED).collect::<Vec<_>>(), [true, false, true, false, true]);
    }

    #[test]
    fn clear_rect_and_read_unpremultiplied() {
        let mut r = ras(2, 1);
        r.st.paint = Paint::Color(premul(0x80ff_0000));
        r.fill_rect(0.0, 0.0, 2.0, 1.0);
        r.clear_rect(1.0, 0.0, 1.0, 1.0);
        let px = r.read(0, 0, 0, 2, 1);
        assert_eq!(px[3], 0x80);
        assert!(px[2] >= 253);
        assert_eq!(&px[4..8], &[0, 0, 0, 0]);
    }
}
