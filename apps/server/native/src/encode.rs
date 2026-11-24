//! Кодирование: кадры YUV уходят в ffmpeg (x264) через трубу из отдельного потока —
//! пока ffmpeg жмёт кадр, Node уже рисует следующий. Буферы кадров переиспользуются.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::thread::JoinHandle;

use crate::raster::Surface;
use crate::yuv::{frame_len, yuv420_x2};

pub struct Encoder {
    child: Child,
    tx: Option<SyncSender<Vec<u8>>>,
    back: Receiver<Vec<u8>>,
    writer: Option<JoinHandle<std::io::Result<()>>>,
    err: Option<JoinHandle<String>>,
    w: u32,
    h: u32,
    pub frames: u32,
}

impl Encoder {
    /// args — всё после `-i pipe:0` не нужно: вход (yuv420p 2w×2h, fps) Encoder задаёт сам,
    /// args — то, что идёт после входа (кодек, фильтры, файл).
    pub fn start(ffmpeg: &str, w: u32, h: u32, fps: f64, args: &[String]) -> Result<Encoder, String> {
        let size = format!("{}x{}", w * 2, h * 2);
        let fps = format!("{fps}");
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", &size, "-r", &fps, "-i", "pipe:0"])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ffmpeg: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, rx) = sync_channel::<Vec<u8>>(3);
        let (btx, back) = sync_channel::<Vec<u8>>(4);
        let writer = std::thread::spawn(move || -> std::io::Result<()> {
            for buf in rx {
                stdin.write_all(&buf)?;
                let _ = btx.try_send(buf);
            }
            stdin.flush()?;
            Ok(())
        });
        let err = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        Ok(Encoder { child, tx: Some(tx), back, writer: Some(writer), err: Some(err), w, h, frames: 0 })
    }

    pub fn frame(&mut self, s: &Surface) -> Result<(), String> {
        if s.w != self.w || s.h != self.h {
            return Err(format!("кадр {}×{}, а кодер ждёт {}×{}", s.w, s.h, self.w, self.h));
        }
        let mut buf = self.back.try_recv().unwrap_or_else(|_| vec![0u8; frame_len(self.w, self.h)]);
        yuv420_x2(s, &mut buf);
        let tx = self.tx.as_ref().ok_or("кодер уже закрыт")?;
        if tx.send(buf).is_err() {
            return Err(self.fail("ffmpeg закрыл вход"));
        }
        self.frames += 1;
        Ok(())
    }

    fn fail(&mut self, what: &str) -> String {
        let _ = self.child.kill();
        let msg = self.err.take().and_then(|h| h.join().ok()).unwrap_or_default();
        format!("{what}: {}", msg.chars().rev().take(1500).collect::<String>().chars().rev().collect::<String>())
    }

    pub fn finish(mut self) -> Result<u32, String> {
        drop(self.tx.take());
        let w = self.writer.take().unwrap().join().map_err(|_| "поток записи упал".to_string())?;
        if let Err(e) = w {
            return Err(self.fail(&format!("запись в ffmpeg: {e}")));
        }
        let status = self.child.wait().map_err(|e| e.to_string())?;
        let msg = self.err.take().and_then(|h| h.join().ok()).unwrap_or_default();
        if !status.success() {
            return Err(format!("ffmpeg {status}: {msg}"));
        }
        Ok(self.frames)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        if self.tx.is_some() {
            let _ = self.child.kill();
        }
    }
}
