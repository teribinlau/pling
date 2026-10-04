//! 叮一下 · Pling 桌面壳
//! 负责：系统托盘、关闭到托盘、置顶提醒小窗、开机自启、单实例、自动更新、取服务器配置。
//! 所有业务逻辑（数据、调度、通知内容）都在前端，这里只提供窗口和系统能力。
//!
//! 每家客户自己部署一套服务器，桌面安装包是同一个：连哪台服务器、从哪里拿更新，都是运行时才知道的
//! （前端从 `<服务器>/config.json` 读到 `updatesUrl`）。tauri-plugin-updater 的 JS 接口 `check()` 换不了地址，
//! 所以检查 / 下载 / 安装都走下面自己的命令，用 `updater_builder().endpoints(...)` 指定地址。

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_updater::{Update, UpdaterExt};

const APP_NAME: &str = "叮一下";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AlertPayload {
    pub key: String,
    pub reminder_id: String,
    pub occurrence_at: String,
    pub title: String,
    pub body: String,
    pub priority: String,
    pub team_name: String,
    pub team_color: String,
    pub time_label: String,
}

const ALERT_W: f64 = 440.0;
const ALERT_H: f64 = 280.0;

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 弹出（或复用）置顶小窗，并把提醒内容发给它
#[tauri::command]
fn show_alert(app: AppHandle, payload: AlertPayload) -> Result<(), String> {
    let window = match app.get_webview_window("alert") {
        Some(w) => w,
        None => {
            let mut builder = WebviewWindowBuilder::new(&app, "alert", WebviewUrl::App("index.html#/alert".into()))
                .title(APP_NAME)
                .inner_size(ALERT_W, ALERT_H)
                .resizable(false)
                .always_on_top(true)
                .decorations(false)
                .visible(false);
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.skip_taskbar(true);
            }
            // 右下角
            if let Ok(Some(monitor)) = app.primary_monitor() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let x = size.width as f64 / scale - ALERT_W - 24.0;
                let y = size.height as f64 / scale - ALERT_H - 80.0;
                builder = builder.position(x.max(0.0), y.max(0.0));
            }
            builder.build().map_err(|e| e.to_string())?
        }
    };
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    // 新建的窗口前端可能还没挂上监听，多发几次（重复接收无害）
    let handle = app.clone();
    std::thread::spawn(move || {
        for delay in [50u64, 500, 1500, 3000] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let _ = handle.emit_to("alert", "alert-payload", payload.clone());
        }
    });
    Ok(())
}

#[tauri::command]
fn close_alert(app: AppHandle) {
    if let Some(w) = app.get_webview_window("alert") {
        let _ = w.hide();
    }
}

/// 托盘提示文字里显示逾期数量（macOS 同时显示在菜单栏标题）
#[tauri::command]
fn set_tray_badge(app: AppHandle, overdue: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if overdue > 0 {
            format!("{APP_NAME} · {overdue} 条逾期")
        } else {
            APP_NAME.to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
        #[cfg(target_os = "macos")]
        {
            let _ = tray.set_title(if overdue > 0 { Some(overdue.to_string()) } else { None::<String> });
        }
    }
}

// ---------------------------------------------------------------------------
// 服务器配置：取 <服务器>/config.json
// 在这里取而不是在网页里 fetch：网页的来源是 tauri://localhost，服务器的静态文件不一定带 CORS 头。
// 只允许取 …/config.json（https；本机开发可以是 http://localhost）。
// ---------------------------------------------------------------------------

fn config_url_allowed(url: &Url) -> bool {
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local);
    scheme_ok && url.path().ends_with("/config.json")
}

#[tauri::command]
async fn fetch_server_config(url: String) -> Result<String, String> {
    let url = Url::parse(url.trim()).map_err(|_| "bad_url".to_string())?;
    if !config_url_allowed(&url) {
        return Err("bad_url".into());
    }
    // reqwest 用的是不带加密实现的 rustls（和 updater 插件一样），先装上 ring
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(concat!("Pling/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| format!("network: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("http_{}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("network: {e}"))?;
    if bytes.len() > 64 * 1024 {
        return Err("too_large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "not_utf8".to_string())
}

// ---------------------------------------------------------------------------
// 自动更新：地址是运行时的（config.updatesUrl），公钥用 tauri.conf.json 里的
// 先在后台下好（不打断正在干活的人），用户点「重启更新」才安装 —— Windows 上安装会关掉应用。
// ---------------------------------------------------------------------------

#[derive(Default)]
struct PendingUpdate(Mutex<Option<(Update, Vec<u8>)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

fn update_info(u: &Update) -> UpdateInfo {
    UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }
}

/// 查 `endpoint`（latest.json）有没有新版本；有就下载并校验签名，返回版本信息；没有返回 null。
/// 已经下好的会直接返回，不重复下载。
#[tauri::command]
async fn update_download(app: AppHandle, pending: State<'_, PendingUpdate>, endpoint: String) -> Result<Option<UpdateInfo>, String> {
    if let Some((u, _)) = pending.0.lock().map_err(|e| e.to_string())?.as_ref() {
        return Ok(Some(update_info(u)));
    }
    let url = Url::parse(endpoint.trim()).map_err(|e| format!("bad_url: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let info = update_info(&update);
    *pending.0.lock().map_err(|e| e.to_string())? = Some((update, bytes));
    Ok(Some(info))
}

/// 安装下好的新版本并重启（Windows 上安装程序会先把应用关掉）。
/// async：不在主线程上跑（macOS 解包要一会儿，主线程卡住窗口会白屏）
#[tauri::command]
async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let taken = pending.0.lock().map_err(|e| e.to_string())?.take();
    let Some((update, bytes)) = taken else {
        return Err("no_update".into());
    };
    update.install(&bytes).map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            show_alert,
            close_alert,
            set_tray_badge,
            fetch_server_config,
            update_download,
            update_install
        ])
        .setup(|app| {
            // 托盘菜单
            let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
            let mute = MenuItem::with_id(app, "mute", "静音 1 小时", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &mute, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip(APP_NAME)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "mute" => {
                        let _ = app.emit("tray-command", "mute-1h");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 开机自启带 --minimized 参数时不显示主窗口
            let minimized = std::env::args().any(|a| a == "--minimized");
            if let Some(main) = app.get_webview_window("main") {
                if minimized {
                    let _ = main.hide();
                } else {
                    let _ = main.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主窗口 = 最小化到托盘；真正退出走托盘菜单
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pling");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_config_json_is_fetched() {
        let ok = |s: &str| config_url_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://pling.example.cn/config.json"));
        assert!(ok("https://example.cn/pling/config.json"));
        assert!(ok("http://localhost:1420/config.json"));
        assert!(!ok("http://pling.example.cn/config.json"));
        assert!(!ok("https://pling.example.cn/api/rest/v1/profiles"));
        assert!(!ok("file:///etc/config.json"));
    }
}
