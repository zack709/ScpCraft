pub mod config;
pub mod editor_watch;
pub mod fs_trait;
mod local_fs;
pub mod menu;
pub mod protocols;
pub mod sftp;
pub mod sync;
pub mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(sftp::manager::SftpSessionManager::default())
        .manage(transfer::engine::TransferEngine::default())
        .manage(editor_watch::EditorWatchManager::default())
        .manage(sftp::shell::ShellSessionManager::default())
        .manage(sync::watcher::KeepUpToDateManager::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Ok(app_menu) = menu::build_app_menu(app.handle()) {
                let _ = app.set_menu(app_menu);
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, event);
        })
        .invoke_handler(tauri::generate_handler![
            local_fs::local_list_drives,
            local_fs::local_list_dir,
            local_fs::local_create_dir,
            local_fs::local_create_file,
            local_fs::local_rename,
            local_fs::local_delete,
            local_fs::local_copy_or_move,
            local_fs::local_get_properties,
            config::site_repo::site_list,
            config::site_repo::site_save,
            config::site_repo::site_delete,
            config::site_repo::site_rename,
            config::site_repo::site_clone,
            config::site_repo::site_create_folder,
            config::site_repo::site_delete_folder,
            config::site_repo::site_set_show_on_startup,
            config::site_repo::site_get_secret,
            config::site_repo::site_import_yaml,
            config::site_repo::site_export_yaml,
            config::site_repo::site_import_winscp_ini,
            config::site_repo::site_export_winscp_ini,
            config::site_repo::site_import_winscp_registry,
            config::site_repo::site_parse_session_url,
            config::site_repo::site_generate_session_url,
            sftp::manager::sftp_connect,
            sftp::manager::sftp_connect_respond,
            sftp::manager::sftp_connect_cancel,
            sftp::manager::sftp_trust_host_key,
            sftp::manager::sftp_disconnect,
            sftp::manager::sftp_session_status,
            sftp::manager::sftp_inspect_key_file,
            sftp::ops::sftp_list_dir,
            sftp::ops::sftp_create_dir,
            sftp::ops::sftp_create_file,
            sftp::ops::sftp_rename,
            sftp::ops::sftp_delete,
            sftp::ops::sftp_create_symlink,
            sftp::ops::sftp_get_properties,
            sftp::ops::sftp_set_permissions,
            sftp::ops::sftp_list_bookmarks,
            sftp::ops::sftp_save_bookmarks,
            transfer::engine::transfer_enqueue,
            transfer::engine::transfer_get_snapshot,
            transfer::engine::transfer_control_item,
            transfer::engine::transfer_control_all,
            transfer::engine::transfer_resolve_conflict,
            transfer::engine::transfer_update_settings,
            editor_watch::editor_open_file,
            editor_watch::editor_save_file,
            editor_watch::editor_reload_file,
            editor_watch::editor_open_external,
            editor_watch::editor_close_file,
            sftp::shell::sftp_pty_open,
            sftp::shell::sftp_pty_write,
            sftp::shell::sftp_pty_resize,
            sftp::shell::sftp_pty_close,
            sftp::shell::sftp_exec_command,
            sftp::shell::local_exec_command,
            sftp::shell::custom_commands_list,
            sftp::shell::custom_commands_save,
            sftp::shell::custom_command_expand,
            sync::diff::sync_compare_directories,
            sync::diff::sync_execute_checklist,
            sync::diff::find_files_search,
            sync::watcher::sync_keep_up_to_date_start,
            sync::watcher::sync_keep_up_to_date_stop,
            sync::watcher::sync_keep_up_to_date_status,
            menu::app_preferences_get,
            menu::app_preferences_save,
            menu::app_cleanup_inspect,
            menu::app_cleanup_execute,
            menu::site_generate_url_bundle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
