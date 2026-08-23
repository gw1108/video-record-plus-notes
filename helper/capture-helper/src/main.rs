//! Native capture helper (tech-stack report §3.6, perf report §4.3/§5).
//!
//! Subcommands:
//!   hotkey --vk <VK>=<label> [--vk ...]
//!     Raw Input (RIDEV_INPUTSINK) mark-hotkey listener — the fallback for
//!     titles where RegisterHotKey fails, and a parallel delivery channel
//!     that does NOT swallow the key (never a WH_KEYBOARD_LL hook). Prints
//!     one JSON line to stdout per key-down:
//!       {"type":"hotkey","label":"mark","vk":119,"wall_ms":1755846000123}
//!     Wall-clock ms is the cross-process timestamp; the recorder maps it
//!     onto its monotonic clock and anchors against GetRecordStatus.
//!
//!   webcam
//!     Phase 2 stub: separate webcam track via MJPEG passthrough to disk or
//!     a second NVENC session (perf report §6.2). Not implemented yet.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentProcess, SetProcessInformation, ProcessPowerThrottling,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE,
};
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RIM_TYPEKEYBOARD,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WNDCLASSW,
};

static KEYMAP: OnceLock<HashMap<u16, String>> = OnceLock::new();
static PRESSED: Mutex<Option<HashSet<u16>>> = Mutex::new(None);

fn wall_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Opt out of EcoQoS so Windows 11 doesn't demote this backgrounded process
/// to E-cores mid-session (perf report §8).
fn disable_eco_qos() {
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: 0,
    };
    unsafe {
        let _ = SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &state as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
}

fn emit(label: &str, vk: u16) {
    let line = format!(
        "{{\"type\":\"hotkey\",\"label\":\"{}\",\"vk\":{},\"wall_ms\":{}}}",
        label,
        vk,
        wall_ms()
    );
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        let mut raw = RAWINPUT::default();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let copied = GetRawInputData(
            HRAWINPUT(lparam.0 as _),
            RID_INPUT,
            Some(&mut raw as *mut _ as *mut core::ffi::c_void),
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        );
        if copied != u32::MAX && raw.header.dwType == RIM_TYPEKEYBOARD.0 {
            let kb = raw.data.keyboard;
            let vk = kb.VKey;
            let key_break = kb.Flags & 1 != 0; // RI_KEY_BREAK = key up
            let mut pressed_guard = PRESSED.lock().unwrap();
            let pressed = pressed_guard.get_or_insert_with(HashSet::new);
            if key_break {
                pressed.remove(&vk);
            } else if !pressed.contains(&vk) {
                pressed.insert(vk); // suppress auto-repeat until key up
                if let Some(label) = KEYMAP.get().and_then(|m| m.get(&vk)) {
                    emit(label, vk);
                }
            }
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn parse_vk(spec: &str) -> Result<(u16, String), String> {
    let (vk_str, label) = spec
        .split_once('=')
        .ok_or_else(|| format!("expected <VK>=<label>, got '{spec}'"))?;
    let vk = if let Some(hex) = vk_str.strip_prefix("0x").or_else(|| vk_str.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16)
    } else {
        vk_str.parse::<u16>()
    }
    .map_err(|_| format!("bad VK code '{vk_str}'"))?;
    Ok((vk, label.to_string()))
}

fn run_hotkey(args: &[String]) -> Result<(), String> {
    let mut keymap = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--vk" => {
                let spec = args.get(i + 1).ok_or("missing value after --vk")?;
                let (vk, label) = parse_vk(spec)?;
                keymap.insert(vk, label);
                i += 2;
            }
            other => return Err(format!("unknown argument '{other}'")),
        }
    }
    if keymap.is_empty() {
        return Err("no keys registered; pass at least one --vk <VK>=<label> (F8 = 0x77)".into());
    }
    eprintln!(
        "capture-helper: listening via Raw Input for {} key(s): {:?}",
        keymap.len(),
        keymap
    );
    KEYMAP.set(keymap).ok();
    disable_eco_qos();

    unsafe {
        let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let class_name = w!("PlaytestCaptureHelper");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return Err("RegisterClassW failed".into());
        }
        // Message-only window: receives WM_INPUT without any visible surface.
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            instance,
            None,
        )
        .map_err(|e| format!("CreateWindowExW failed: {e}"))?;

        let rid = RAWINPUTDEVICE {
            usUsagePage: 0x01, // generic desktop
            usUsage: 0x06,     // keyboard
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        };
        RegisterRawInputDevices(&[rid], std::mem::size_of::<RAWINPUTDEVICE>() as u32)
            .map_err(|e| format!("RegisterRawInputDevices failed: {e}"))?;

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("hotkey") => run_hotkey(&args[1..]),
        Some("webcam") => {
            eprintln!(
                "capture-helper webcam: not implemented yet (Phase 2). Plan: MJPEG passthrough \
                 to disk or a second NVENC session via Media Foundation (perf report §6.2)."
            );
            std::process::exit(2);
        }
        _ => Err("usage: capture-helper hotkey --vk <VK>=<label> [--vk ...] | capture-helper webcam".into()),
    };
    if let Err(err) = result {
        eprintln!("capture-helper: {err}");
        std::process::exit(1);
    }
}
