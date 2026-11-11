//! Utilitaires pour lancer des processus Windows sans faire clignoter de console.

use std::io::{self, Read};
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `Command` qui n'ouvre pas de fenêtre de console.
pub fn hidden(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Lance la commande et attend sa fin. `Ok(None)` si le délai est dépassé
/// (le processus est alors arrêté).
pub fn status_with_timeout(mut cmd: Command, timeout: Duration) -> io::Result<Option<ExitStatus>> {
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Sortie d'un processus terminé.
pub struct Captured {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Lecture d'un tuyau dans un thread à part. Le contenu lu est consultable même si le
/// tuyau reste ouvert (un programme lancé par le processus peut le garder après sa fin).
struct Drain {
    buf: Arc<Mutex<Vec<u8>>>,
    handle: std::thread::JoinHandle<()>,
}

fn drain(mut pipe: impl Read + Send + 'static) -> Drain {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::clone(&buf);
    let handle = std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if let Ok(mut b) = shared.lock() {
                b.extend_from_slice(&chunk[..n]);
            }
        }
    });
    Drain { buf, handle }
}

impl Drain {
    /// Laisse un court instant pour finir la lecture, puis renvoie ce qui a été reçu.
    fn collect(self) -> Vec<u8> {
        let wait_until = Instant::now() + Duration::from_secs(2);
        while !self.handle.is_finished() && Instant::now() < wait_until {
            std::thread::sleep(Duration::from_millis(20));
        }
        self.buf.lock().map(|b| b.clone()).unwrap_or_default()
    }
}

/// Lance la commande, récupère ses deux sorties et attend sa fin. `Ok(None)` si le
/// délai est dépassé (le processus est alors arrêté).
pub fn capture(mut cmd: Command, timeout: Duration) -> io::Result<Option<Captured>> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let out = drain(child.stdout.take().expect("stdout est redirigé"));
    let err = drain(child.stderr.take().expect("stderr est redirigé"));

    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(Captured {
                status,
                stdout: out.collect(),
                stderr: err.collect(),
            }));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
