mod proc;
mod ps;
mod repair;
mod scan;
mod settings;
mod system;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let stats = Arc::new(system::StatsState::default());
            system::start_sampler(Arc::clone(&stats));
            app.manage(stats);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system::system_get_info,
            scan::scan_get_temp_dirs,
            scan::clean_delete_dirs,
            settings::settings_get_info,
            settings::settings_set_login_item,
            settings::shell_open_log,
            repair::repair_get_services,
            repair::repair_fix_services,
            repair::repair_run_sfc,
            repair::repair_get_driver_errors,
            repair::repair_fix_driver_errors,
            repair::repair_get_registry_issues,
            repair::repair_fix_registry_issues,
            repair::repair_get_startup_items,
            repair::repair_set_startup_items,
            repair::repair_get_disk_health,
            repair::repair_schedule_disk_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
