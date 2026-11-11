//! Utilitaires pour lancer des processus Windows sans faire clignoter de console.

use std::io::{self, Read};
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
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

/// Comme `status_with_timeout`, mais récupère aussi la sortie standard.
pub fn output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> io::Result<Option<(ExitStatus, Vec<u8>)>> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let mut stdout = child.stdout.take().expect("stdout est redirigé");
    // Lecture dans un thread à part pour ne pas bloquer le contrôle du délai.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some((status, reader.join().unwrap_or_default())));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
