//! Нативный модуль монтажа «Фильма матча» (apps/server/src/film-native.ts).
//!
//! Что рисовать, решает общий с телефоном TS-код сцен (apps/web/src/game/film.ts, clip.ts):
//! он пишет команды Canvas 2D в буфер чисел, модуль их исполняет (`raster`), переводит кадр в YUV ×2
//! (`yuv`) и отдаёт x264 (`encode`). Так правила фильма живут в одном месте, а дорогая часть —
//! заливки, спрайты, текст, растяжка и перевод цвета — идёт без Skia и без копирования пикселей в JS.
//!
//! Формат буфера команд (f64): код, затем аргументы.
//!   1 STATE target a b c d e f alpha comp paintKind paint stroke lineWidth fontPx align baseline
//!   2 RESIZE id w h        3 FILL_RECT x y w h      4 CLEAR_RECT x y w h
//!   5 DRAW_IMAGE src sx sy sw sh dx dy dw dh       6 FILL_TEXT str x y      7 STROKE_RECT x y w h
//!   8 FREE id
//! Цвета — RGBA без умноженной альфы, младший байт — r.

pub mod encode;
pub mod font;
pub mod raster;
pub mod yuv;

use raster::{premul, Align, Baseline, Comp, Mat, Paint, Raster, State};

/// Исполнить буфер команд. Ошибка — неизвестная команда или обрезанный буфер.
pub fn exec(r: &mut Raster, ops: &[f64], strs: &[String]) -> Result<(), String> {
    let mut i = 0;
    let n = ops.len();
    let need = |i: usize, k: usize| -> Result<(), String> {
        if i + k > n {
            Err(format!("команда {} обрезана", ops[i - 1]))
        } else {
            Ok(())
        }
    };
    while i < n {
        let op = ops[i] as u32;
        i += 1;
        match op {
            1 => {
                need(i, 16)?;
                let a = &ops[i..i + 16];
                r.target = a[0] as u32;
                r.st = State {
                    m: Mat { a: a[1], b: a[2], c: a[3], d: a[4], e: a[5], f: a[6] },
                    alpha: a[7],
                    comp: match a[8] as u32 {
                        1 => Comp::SourceIn,
                        2 => Comp::Copy,
                        _ => Comp::SrcOver,
                    },
                    paint: if a[9] as u32 == 1 { Paint::Pattern(a[10] as u32) } else { Paint::Color(premul(a[10] as u32)) },
                    stroke: premul(a[11] as u32),
                    line_width: a[12],
                    font_px: a[13],
                    align: match a[14] as u32 {
                        1 => Align::Center,
                        2 => Align::Right,
                        _ => Align::Left,
                    },
                    baseline: match a[15] as u32 {
                        1 => Baseline::Top,
                        2 => Baseline::Middle,
                        3 => Baseline::Bottom,
                        _ => Baseline::Alphabetic,
                    },
                };
                i += 16;
            }
            2 => {
                need(i, 3)?;
                r.resize(ops[i] as u32, ops[i + 1] as u32, ops[i + 2] as u32);
                i += 3;
            }
            3 | 4 | 7 => {
                need(i, 4)?;
                let (x, y, w, h) = (ops[i], ops[i + 1], ops[i + 2], ops[i + 3]);
                match op {
                    3 => r.fill_rect(x, y, w, h),
                    4 => r.clear_rect(x, y, w, h),
                    _ => r.stroke_rect(x, y, w, h),
                }
                i += 4;
            }
            5 => {
                need(i, 9)?;
                let a = &ops[i..i + 9];
                r.draw_image(a[0] as u32, a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
                i += 9;
            }
            6 => {
                need(i, 3)?;
                let s = strs.get(ops[i] as usize).ok_or("нет строки")?;
                r.fill_text(s, ops[i + 1], ops[i + 2]);
                i += 3;
            }
            8 => {
                need(i, 1)?;
                r.free(ops[i] as u32);
                i += 1;
            }
            _ => return Err(format!("неизвестная команда {op}")),
        }
    }
    Ok(())
}

#[cfg(not(test))]
mod node {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    use crate::encode::Encoder;
    use crate::font::Fonts;
    use crate::raster::Raster;

    #[napi]
    pub struct Engine {
        r: Raster,
        enc: Option<Encoder>,
    }

    fn err(e: String) -> Error {
        Error::new(Status::GenericFailure, e)
    }

    #[napi]
    impl Engine {
        /// fonts — файлы шрифта по порядку подбора букв (woff или ttf).
        #[napi(constructor)]
        pub fn new(fonts: Vec<Buffer>) -> Result<Self> {
            let files: Vec<&[u8]> = fonts.iter().map(|b| b.as_ref()).collect();
            let mut r = Raster::new();
            r.fonts = Some(Fonts::new(&files).map_err(err)?);
            Ok(Engine { r, enc: None })
        }

        #[napi]
        pub fn exec(&mut self, ops: Float64Array, len: u32, strs: Vec<String>) -> Result<()> {
            let ops: &[f64] = &ops;
            crate::exec(&mut self.r, &ops[..(len as usize).min(ops.len())], &strs).map_err(err)
        }

        /// getImageData: RGBA без умноженной альфы.
        #[napi]
        pub fn read(&self, id: u32, x: i32, y: i32, w: u32, h: u32) -> Buffer {
            self.r.read(id, x, y, w, h).into()
        }

        /// Ширина строки для measureText (кегль в пикселях холста).
        #[napi]
        pub fn measure(&mut self, s: String, px: f64) -> f64 {
            self.r.fonts.as_mut().map(|f| f.measure(&s, px)).unwrap_or(0.0)
        }

        /// Высота от верха строки до базовой линии (для textBaseline = top).
        #[napi]
        pub fn ascent(&self, px: f64) -> f64 {
            self.r.fonts.as_ref().map(|f| f.line(px).top).unwrap_or(px)
        }

        /// JPEG холста (обложка фильма).
        #[napi]
        pub fn jpeg(&self, id: u32, quality: u8) -> Result<Buffer> {
            let s = self.r.surface(id).ok_or_else(|| err("нет холста".into()))?;
            let rgba = self.r.read(id, 0, 0, s.w, s.h);
            let mut out = Vec::new();
            let enc = jpeg_encoder::Encoder::new(&mut out, quality);
            enc.encode(&rgba, s.w as u16, s.h as u16, jpeg_encoder::ColorType::Rgba).map_err(|e| err(e.to_string()))?;
            Ok(out.into())
        }

        /// Начать кодирование кадров w×h (в файл они уйдут ×2). args — кодек, фильтры, выходной файл.
        #[napi]
        pub fn encode_start(&mut self, ffmpeg: String, w: u32, h: u32, fps: f64, args: Vec<String>) -> Result<()> {
            self.enc = Some(Encoder::start(&ffmpeg, w, h, fps, &args).map_err(err)?);
            Ok(())
        }

        /// Отдать холст id кодеру как следующий кадр.
        #[napi]
        pub fn encode_frame(&mut self, id: u32) -> Result<()> {
            let s = self.r.surface(id).ok_or_else(|| err("нет холста".into()))?;
            self.enc.as_mut().ok_or_else(|| err("кодер не запущен".into()))?.frame(s).map_err(err)
        }

        /// Дождаться ffmpeg; вернуть число кадров.
        #[napi]
        pub fn encode_finish(&mut self) -> Result<u32> {
            self.enc.take().ok_or_else(|| err("кодер не запущен".into()))?.finish().map_err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_runs_a_frame_and_rejects_garbage() {
        let mut r = Raster::new();
        let red = 0xff00_00ffu32 as f64;
        let ops = [
            2.0, 0.0, 4.0, 4.0, // RESIZE 0 4×4
            1.0, 0.0, 2.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.0, 0.0, red, 0.0, 1.0, 8.0, 0.0, 0.0, // STATE ×2, красный
            3.0, 0.0, 0.0, 1.0, 1.0, // FILL_RECT
        ];
        exec(&mut r, &ops, &[]).unwrap();
        let s = r.surface(0).unwrap();
        assert_eq!(s.px.iter().filter(|&&c| c == 0xff00_00ff).count(), 4);
        assert!(exec(&mut r, &[99.0], &[]).is_err());
        assert!(exec(&mut r, &[3.0, 1.0], &[]).is_err());
    }
}
