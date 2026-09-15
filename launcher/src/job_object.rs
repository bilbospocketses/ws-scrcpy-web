// Windows Job Object that owns the Node child + its descendants.
//
// Without this, killing the launcher (Servy stop, Task Manager, MSI uninstall)
// can leave the Node grandchild + its node-pty descendants resident. v0.1.21
// shipped with that bug visible as: orphaned node.exe after service uninstall,
// and `pty.node` MSI-renamed to `C:\Config.Msi\<id>.rbf` because the running
// Node process still held the .node loaded.
//
// Pattern: a single process-wide unnamed Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The launcher holds the only handle for
// its full lifetime — when the launcher process exits (graceful or killed),
// the OS closes the last handle, the job destructs, and Windows terminates
// every process in the job (Node + node-pty + scrcpy.exe etc.). Job
// membership is inherited by default, so children spawned by Node also land
// in the job automatically.
//
// Failure modes are swallowed (return Err to the caller, which logs and
// continues). Reasons:
//   - launcher itself in a parent job that doesn't allow nesting (rare on
//     modern Windows but possible under some MDM / debugger configurations)
//   - ERROR_ACCESS_DENIED on OpenProcess if the child somehow lost privileges
// In any of these cases we want the launcher to keep running with v0.1.21
// behavior (graceful degradation) rather than refuse to start.
//
// v0.1.23-beta.9 update — graceful-exit release:
// The kill-on-close behavior is exactly right for ABNORMAL termination
// (Servy stop, Task Manager kill, launcher crash) — those bypass our
// cleanup path and the kernel's job-tear-down is the safety net.
//
// But for GRACEFUL exit, kill-on-close is too eager. Velopack's in-app
// updater spawns Update.exe as a grandchild (launcher → node → Update.exe)
// to perform the package swap AFTER the parent process exits. Since job
// membership inherits, Update.exe lands in our job. When Node exits cleanly
// after applyUpdate(), the supervisor exits, main() exits, our last job
// handle closes, and the kernel TerminateProcess's Update.exe mid-extract
// — leaving the install in a half-state and requiring a manual relaunch
// to complete the upgrade.
//
// Fix: `release()` clears the KILL_ON_JOB_CLOSE flag on the existing job
// before main() returns. Job still gets destroyed when the launcher exits,
// but its remaining members (notably Update.exe) survive. Hard-kill paths
// don't run our cleanup, so the v0.1.21 safety net stays intact for them.
// Diagnosed v0.1.23-beta.7→beta.8 apply flow via Velopack log cutting off
// mid-line at "Extracting 393 app files" — classic TerminateProcess
// signature.

use anyhow::{Context, Result, anyhow};
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::sync::OnceLock;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::core::PCWSTR;

struct JobHandle(HANDLE);
// SAFETY: HANDLE is an integer-sized opaque value; the Windows kernel handles
// thread safety on the operations we perform (AssignProcessToJobObject is
// documented as thread-safe).
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

fn create_job() -> Option<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let res = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if res.is_err() {
            let _ = CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

/// Assign the spawned child to the launcher's process-wide kill-on-close
/// Job Object. Idempotent across calls (re-assigning the same process is a
/// no-op error which we ignore); but in our codebase we only ever spawn one
/// supervised Node child at a time.
pub fn adopt(child: &Child) -> Result<()> {
    let job_handle = JOB
        .get_or_init(|| create_job().map(JobHandle))
        .as_ref()
        .ok_or_else(|| anyhow!("could not create Job Object"))?
        .0;

    let raw = child.as_raw_handle();
    let proc = HANDLE(raw);
    unsafe {
        AssignProcessToJobObject(job_handle, proc).context("AssignProcessToJobObject failed")?;
    }
    Ok(())
}

/// Clear the KILL_ON_JOB_CLOSE flag on the launcher's job so that — when
/// the launcher exits and its last handle to the job closes — the job
/// dissolves WITHOUT killing the remaining members.
///
/// Called from main() right before std::process::exit() on the graceful
/// shutdown path. Lets Velopack's Update.exe grandchild outlive us during
/// the in-app updater apply flow (see module-level docs).
///
/// Returns:
///   - `Ok(true)`  when the flag was cleared on a real job
///   - `Ok(false)` when there was no job to release (adopt() never called,
///     or create_job() failed earlier — both legitimate, neither an error)
///   - `Err(_)`    when SetInformationJobObject itself returned a Win32
///     error. Caller should log and continue exiting; failing here doesn't
///     leave the launcher worse off than the pre-fix v0.1.21 behavior.
///
/// Idempotent: calling release() multiple times after the flag is already
/// cleared is a no-op (Win32 SetInformationJobObject with the same payload
/// succeeds without changing observable state).
pub fn release() -> Result<bool> {
    let Some(slot) = JOB.get() else {
        // adopt() was never called; OnceLock empty.
        return Ok(false);
    };
    let Some(handle) = slot.as_ref() else {
        // create_job() failed earlier; we logged at adopt() time, nothing to clear.
        return Ok(false);
    };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // Explicit zero — no kill-on-close, no other flags. The job becomes
    // a passive container for membership tracking until destruction.
    info.BasicLimitInformation.LimitFlags = windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT(0);
    unsafe {
        SetInformationJobObject(
            handle.0,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .context("SetInformationJobObject(release) failed")?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The static `JOB` OnceLock is module-global, so tests share it. We
    // therefore have a single combined happy-path test rather than separate
    // "before adopt" / "after adopt" / "idempotent" cases that would race.
    // Real KILL_ON_JOB_CLOSE-vs-release behavior is verified via VM smoke,
    // not unit tests (requires a real grandchild process surviving exit).
    #[test]
    fn release_after_adopt_succeeds_and_is_idempotent() {
        // Spawn a short-lived child to feed adopt(). `cmd /c exit 0` is the
        // smallest Windows process we can reliably spawn from tests.
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "exit", "0"])
            .spawn()
            .expect("spawn cmd /c exit 0");
        adopt(&child).expect("adopt should succeed for fresh child");

        // First release: clears the flag. Should report Ok(true).
        assert!(
            matches!(release(), Ok(true)),
            "first release returns Ok(true)"
        );

        // Second release: idempotent — Win32 SetInformationJobObject with
        // the same payload still succeeds, so we still see Ok(true).
        assert!(matches!(release(), Ok(true)), "release is idempotent");

        let _ = child.wait();
    }
}
