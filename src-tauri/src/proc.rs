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

/// Arrête un processus **et tous ceux qu'il a lancés** : arrêter seulement le gestionnaire de
/// paquets laisserait son installateur tourner dans le vide, et un nouvel essai se heurterait à
/// « une autre installation est en cours ». (Un programme lancé avec les droits administrateur
/// ne peut pas être arrêté depuis ici.)
pub fn kill_tree(pid: u32) {
    let _ = hidden("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

/// Lance la commande, récupère ses deux sorties et attend sa fin. `Ok(None)` si le
/// délai est dépassé (le processus et ses enfants sont alors arrêtés).
pub fn capture(cmd: Command, timeout: Duration) -> io::Result<Option<Captured>> {
    capture_watched(cmd, timeout, None, &mut || {})
}

/// Comme `capture`, et appelle `on_slow` une fois si la commande dure plus de `slow_after`.
/// Sert à prévenir l'utilisateur qu'une installation est longue (ou attend son autorisation).
pub fn capture_watched(
    mut cmd: Command,
    timeout: Duration,
    slow_after: Option<Duration>,
    on_slow: &mut dyn FnMut(),
) -> io::Result<Option<Captured>> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let out = drain(child.stdout.take().expect("stdout est redirigé"));
    let err = drain(child.stderr.take().expect("stderr est redirigé"));

    let started = Instant::now();
    let deadline = started + timeout;
    let mut warned = false;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(Captured {
                status,
                stdout: out.collect(),
                stderr: err.collect(),
            }));
        }
        if !warned && slow_after.is_some_and(|after| started.elapsed() >= after) {
            warned = true;
            on_slow();
        }
        if Instant::now() >= deadline {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn powershell(script: &str) -> Command {
        let mut cmd = hidden("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        cmd
    }

    #[test]
    fn slow_commands_are_reported_once_and_still_complete() {
        let mut calls = 0;
        let res = capture_watched(
            powershell("Start-Sleep 3; Write-Output fini"),
            Duration::from_secs(30),
            Some(Duration::from_secs(1)),
            &mut || calls += 1,
        )
        .unwrap()
        .expect("la commande doit se terminer");
        assert_eq!(
            calls, 1,
            "un seul avertissement, même si la commande est longue"
        );
        assert!(String::from_utf8_lossy(&res.stdout).contains("fini"));
    }

    #[test]
    fn quick_commands_never_warn() {
        let mut calls = 0;
        let res = capture_watched(
            powershell("Write-Output ok"),
            Duration::from_secs(30),
            Some(Duration::from_secs(20)),
            &mut || calls += 1,
        )
        .unwrap();
        assert!(res.is_some());
        assert_eq!(calls, 0);
    }

    /// Un programme lancé par la commande doit disparaître avec elle (cas d'un installateur
    /// lancé par winget), sinon il resterait à moitié installé et bloquerait le nouvel essai.
    #[test]
    fn timeout_stops_the_programs_it_started() {
        // Marqueur propre à ce test : `ping` vers une adresse et un nombre de répétitions inhabituels.
        let marker = "-n 47 127.0.0.9";
        let started = Instant::now();
        let res = capture(
            powershell("Start-Process -NoNewWindow -Wait ping -ArgumentList '-n','47','127.0.0.9'"),
            Duration::from_secs(3),
        )
        .unwrap();
        assert!(res.is_none(), "le délai doit être dépassé");
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "doit s'arrêter vite"
        );

        std::thread::sleep(Duration::from_secs(1));
        let check = format!(
            "(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object {{ $_.CommandLine -like '*{marker}*' }} | Measure-Object).Count"
        );
        let out = capture(powershell(&check), Duration::from_secs(20))
            .unwrap()
            .unwrap();
        let remaining = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert_eq!(
            remaining, "0",
            "le programme lancé par la commande tourne encore"
        );
    }
}
