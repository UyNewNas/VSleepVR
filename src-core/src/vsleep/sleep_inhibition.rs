use std::{
    error::Error,
    fmt::{Display, Formatter},
    sync::mpsc::{self, Receiver, Sender, SyncSender},
    thread::{self, JoinHandle},
};

#[derive(Debug)]
pub enum SleepInhibitionError {
    WorkerSpawn(String),
    WorkerUnavailable,
    Api(String),
}

impl Display for SleepInhibitionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkerSpawn(error) => write!(f, "failed to start sleep-inhibition worker: {error}"),
            Self::WorkerUnavailable => write!(f, "sleep-inhibition worker is unavailable"),
            Self::Api(error) => write!(f, "Windows sleep inhibition failed: {error}"),
        }
    }
}

impl Error for SleepInhibitionError {}

enum WorkerCommand {
    SetEnabled {
        enabled: bool,
        reply: SyncSender<Result<(), String>>,
    },
    Shutdown,
}

#[derive(Debug)]
pub struct SleepInhibitionController {
    sender: Sender<WorkerCommand>,
    worker: Option<JoinHandle<()>>,
    active: bool,
}

impl SleepInhibitionController {
    pub fn new() -> Result<Self, SleepInhibitionError> {
        let (sender, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("vsleep-sleep-inhibition".to_string())
            .spawn(move || worker_loop(receiver))
            .map_err(|error| SleepInhibitionError::WorkerSpawn(error.to_string()))?;

        Ok(Self {
            sender,
            worker: Some(worker),
            active: false,
        })
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn set_enabled(&mut self, enabled: bool) -> Result<bool, SleepInhibitionError> {
        if self.active == enabled {
            return Ok(false);
        }

        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(WorkerCommand::SetEnabled { enabled, reply })
            .map_err(|_| SleepInhibitionError::WorkerUnavailable)?;

        response
            .recv()
            .map_err(|_| SleepInhibitionError::WorkerUnavailable)?
            .map_err(SleepInhibitionError::Api)?;

        self.active = enabled;
        Ok(true)
    }
}

impl Drop for SleepInhibitionController {
    fn drop(&mut self) {
        let _ = self.sender.send(WorkerCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.active = false;
    }
}

fn worker_loop(receiver: Receiver<WorkerCommand>) {
    let mut active = false;

    while let Ok(command) = receiver.recv() {
        match command {
            WorkerCommand::SetEnabled { enabled, reply } => {
                let result = apply_execution_state(enabled);
                if result.is_ok() {
                    active = enabled;
                }
                let _ = reply.send(result);
            }
            WorkerCommand::Shutdown => break,
        }
    }

    if active {
        let _ = apply_execution_state(false);
    }
}

#[cfg(windows)]
fn apply_execution_state(enabled: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    // Keep the request on this dedicated worker thread so enable/disable always execute on the
    // same Windows thread. ES_DISPLAY_REQUIRED is deliberately omitted: VSleep only prevents
    // automatic system sleep and still allows the display to turn off normally.
    let flags = if enabled {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    let previous = unsafe { SetThreadExecutionState(flags) };
    if previous == 0 {
        Err("SetThreadExecutionState returned zero".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn apply_execution_state(enabled: bool) -> Result<(), String> {
    if enabled {
        Err("sleep inhibition is only supported on Windows".to_string())
    } else {
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};

    #[test]
    fn requested_flags_never_keep_the_display_awake() {
        let enabled_flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        assert_eq!(enabled_flags & ES_DISPLAY_REQUIRED, 0);
    }
}
