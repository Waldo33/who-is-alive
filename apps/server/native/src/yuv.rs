//! Кадр холста → YUV 4:2:0 для x264 с растяжкой ×2 «ближайшим соседом».
//!
//! При ×2 каждый пиксель холста становится квадратом 2×2, поэтому цветность 4:2:0 (одна пара U/V на
//! квадрат 2×2) берётся ровно из одного пикселя исходника — без усреднения и без потери чёткости цвета.
//! Коэффициенты — BT.601 в ограниченном диапазоне, как у swscale по умолчанию (старый рендер:
//! `scale=…:flags=neighbor,format=yuv420p`), чтобы цвета роликов не поменялись.

use crate::raster::{unpremul, Surface};

#[inline(always)]
fn ycc(c: u32) -> (u8, u8, u8) {
    let c = unpremul(c);
    let r = (c & 255) as i32;
    let g = ((c >> 8) & 255) as i32;
    let b = ((c >> 16) & 255) as i32;
    let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    (y.clamp(0, 255) as u8, u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

/// Размер кадра YUV 4:2:0 для холста w×h при растяжке ×2.
pub fn frame_len(w: u32, h: u32) -> usize {
    let (w2, h2) = (w as usize * 2, h as usize * 2);
    w2 * h2 + 2 * (w as usize * h as usize)
}

/// Записать кадр (плоскости Y, U, V подряд) в out длиной frame_len.
pub fn yuv420_x2(s: &Surface, out: &mut [u8]) {
    let (w, h) = (s.w as usize, s.h as usize);
    let w2 = w * 2;
    let (yp, rest) = out.split_at_mut(w2 * h * 2);
    let (up, vp) = rest.split_at_mut(w * h);
    let mut last = (u32::MAX, (0u8, 0u8, 0u8));
    for j in 0..h {
        let row = &s.px[j * w..j * w + w];
        let (y0, y1) = yp[(2 * j) * w2..(2 * j + 2) * w2].split_at_mut(w2);
        let ur = &mut up[j * w..j * w + w];
        let vr = &mut vp[j * w..j * w + w];
        for (i, &c) in row.iter().enumerate() {
            // соседние пиксели пиксель-арта чаще всего одного цвета — не пересчитывать
            if c != last.0 {
                last = (c, ycc(c));
            }
            let (y, u, v) = last.1;
            y0[2 * i] = y;
            y0[2 * i + 1] = y;
            ur[i] = u;
            vr[i] = v;
        }
        // вторая строка квадрата 2×2 — копия первой
        y1.copy_from_slice(y0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_white_and_doubling() {
        let mut s = Surface::new(2, 1);
        s.px = vec![0xff00_0000, 0xffff_ffff];
        let mut out = vec![0; frame_len(2, 1)];
        yuv420_x2(&s, &mut out);
        // Y: 4×2, чёрный 16, белый 235
        assert_eq!(&out[..8], &[16, 16, 235, 235, 16, 16, 235, 235]);
        // U, V серые
        assert_eq!(&out[8..], &[128, 128, 128, 128]);
    }

    #[test]
    fn red_matches_bt601_limited() {
        let mut s = Surface::new(1, 1);
        s.px = vec![0xff00_00ff];
        let mut out = vec![0; frame_len(1, 1)];
        yuv420_x2(&s, &mut out);
        assert_eq!(out[0], 82);
        assert_eq!(out[4], 90);
        assert_eq!(out[5], 240);
    }
}
