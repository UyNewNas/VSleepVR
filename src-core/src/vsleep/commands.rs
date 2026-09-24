use super::{SessionEvent, SessionFileInfo, INSTANCE};

const NOT_INITIALIZED: &str = "VSleep session journal runtime is not initialized";

#[tauri::command]
pub async fn vsleep_active_session_id() -> Result<Option<String>, String> {
    let instance = INSTANCE.lock().await;
    let runtime = instance.as_ref().ok_or_else(|| NOT_INITIALIZED.to_string())?;
    Ok(runtime.active_session_id().map(str::to_string))
}

#[tauri::command]
pub async fn vsleep_start_session() -> Result<String, String> {
    let mut instance = INSTANCE.lock().await;
    let runtime = instance
        .as_mut()
        .ok_or_else(|| NOT_INITIALIZED.to_string())?;
    runtime.start_session().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vsleep_finish_session() -> Result<bool, String> {
    let mut instance = INSTANCE.lock().await;
    let runtime = instance
        .as_mut()
        .ok_or_else(|| NOT_INITIALIZED.to_string())?;
    runtime
        .finish_session()
        .map(|event| event.is_some())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vsleep_sleep_inhibition_active() -> Result<bool, String> {
    let instance = INSTANCE.lock().await;
    let runtime = instance.as_ref().ok_or_else(|| NOT_INITIALIZED.to_string())?;
    Ok(runtime.sleep_inhibition_active())
}

#[tauri::command]
pub async fn vsleep_set_sleep_inhibition(enabled: bool) -> Result<bool, String> {
    let mut instance = INSTANCE.lock().await;
    let runtime = instance
        .as_mut()
        .ok_or_else(|| NOT_INITIALIZED.to_string())?;
    runtime
        .set_sleep_inhibition(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vsleep_list_sessions() -> Result<Vec<SessionFileInfo>, String> {
    let instance = INSTANCE.lock().await;
    let runtime = instance.as_ref().ok_or_else(|| NOT_INITIALIZED.to_string())?;
    runtime.list_sessions().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vsleep_read_session(file_name: String) -> Result<Vec<SessionEvent>, String> {
    let instance = INSTANCE.lock().await;
    let runtime = instance.as_ref().ok_or_else(|| NOT_INITIALIZED.to_string())?;
    runtime
        .read_session(&file_name)
        .map_err(|error| error.to_string())
}
