//! Native capture helper (tech-stack report §3.6, perf report §4.3/§5).
//!
//! Subcommands:
//!   hotkey [--key VK:MODS=label] [--mouse BTN:MODS=label] [--pad CODE=label]
//!          [--hid VID:PID:IDX=label] [--vk VK=label (legacy, MODS=0)]
//!     Mark-hotkey listener — a parallel delivery channel that never swallows
//!     the input (never a WH_KEYBOARD_LL hook):
//!       - keyboard keys via Raw Input RIDEV_INPUTSINK, with an exact
//!         Ctrl/Shift/Alt chord match (MODS bitmask: 1=ctrl 2=shift 4=alt)
//!       - mouse buttons via mouse Raw Input (BTN: left|right|middle|x1|x2)
//!       - XInput pads via polling (CODE: XINPUT_GAMEPAD_* mask bit, or
//!         0x10000 / 0x20000 for the left / right trigger)
//!       - generic HID joystick/gamepad/pedal buttons via HID Raw Input +
//!         HidP report parsing (IDX is zero-based from the device's first
//!         button-usage range; XInput devices — "IG_" in the device path —
//!         are skipped here so a press never fires twice)
//!     Prints one JSON line per press:
//!       {"type":"hotkey","label":"mark","wall_ms":1755846000123}
//!     Wall-clock ms is the cross-process timestamp; the recorder maps it
//!     onto its monotonic clock and anchors against GetRecordStatus.
//!
//!   capture
//!     Binding capture for the settings UI: reports the identity of every
//!     XInput / generic-HID button press (keyboard/mouse capture happens in
//!     the renderer via DOM events) until killed:
//!       {"type":"capture","source":"xinput","code":4096,"wall_ms":...}
//!       {"type":"capture","source":"hid","vendor":1356,"product":2508,"button":1,"wall_ms":...}

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::core::w;
use windows::Win32::Devices::HumanInterfaceDevice::{
    HidP_GetButtonCaps, HidP_GetCaps, HidP_GetUsages, HidP_Input, HIDP_BUTTON_CAPS, HIDP_CAPS,
    PHIDP_PREPARSED_DATA,
};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentProcess, SetProcessInformation, ProcessPowerThrottling,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE,
};
use windows::Win32::UI::Input::XboxController::{XInputGetState, XINPUT_STATE};
use windows::Win32::UI::Input::{
    GetRawInputData, GetRawInputDeviceInfoW, RegisterRawInputDevices, HRAWINPUT, RAWINPUT,
    RAWINPUTDEVICE, RAWINPUTHEADER, RIDI_DEVICEINFO, RIDI_DEVICENAME, RIDI_PREPARSEDDATA,
    RID_DEVICE_INFO, RID_INPUT, RIDEV_INPUTSINK, RIM_TYPEHID, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WNDCLASSW,
};

// Modifier chord bitmask shared with the recorder: 1=ctrl 2=shift 4=alt.
const MOD_CTRL: u8 = 1;
const MOD_SHIFT: u8 = 2;
const MOD_ALT: u8 = 4;

// RAWMOUSE usButtonFlags "down" bits.
const RI_MOUSE_LEFT_DOWN: u16 = 0x0001;
const RI_MOUSE_RIGHT_DOWN: u16 = 0x0004;
const RI_MOUSE_MIDDLE_DOWN: u16 = 0x0010;
const RI_MOUSE_X1_DOWN: u16 = 0x0040;
const RI_MOUSE_X2_DOWN: u16 = 0x0100;

// Pseudo-codes for the analog XInput triggers (real buttons use the mask bit).
const PAD_LEFT_TRIGGER: u32 = 0x10000;
const PAD_RIGHT_TRIGGER: u32 = 0x20000;
const TRIGGER_THRESHOLD: u8 = 30; // XINPUT_GAMEPAD_TRIGGER_THRESHOLD

struct KeyBinding {
    vk: u16,
    mods: u8,
    label: String,
}

struct MouseBinding {
    down_flag: u16,
    mods: u8,
    label: String,
}

struct PadBinding {
    code: u32,
    label: String,
}

struct HidBinding {
    vendor: u16,
    product: u16,
    index: u16,
    label: String,
}

#[derive(Default)]
struct Config {
    keys: Vec<KeyBinding>,
    mouse: Vec<MouseBinding>,
    hid: Vec<HidBinding>,
    pads: Vec<PadBinding>,
    /// capture subcommand: report XInput/HID press identities instead of labels.
    capture: bool,
}

static CONFIG: OnceLock<Config> = OnceLock::new();
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

fn emit_line(line: String) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn emit_hotkey(label: &str) {
    emit_line(format!(
        "{{\"type\":\"hotkey\",\"label\":\"{}\",\"wall_ms\":{}}}",
        label,
        wall_ms()
    ));
}

fn emit_capture_xinput(code: u32) {
    emit_line(format!(
        "{{\"type\":\"capture\",\"source\":\"xinput\",\"code\":{},\"wall_ms\":{}}}",
        code,
        wall_ms()
    ));
}

fn emit_capture_hid(vendor: u16, product: u16, button: u16) {
    emit_line(format!(
        "{{\"type\":\"capture\",\"source\":\"hid\",\"vendor\":{},\"product\":{},\"button\":{},\"wall_ms\":{}}}",
        vendor,
        product,
        button,
        wall_ms()
    ));
}

/// Collapse left/right modifier VKs to the generic ones we track.
fn normalize_vk(vk: u16) -> u16 {
    match vk {
        0xA0 | 0xA1 => 0x10, // VK_L/RSHIFT -> VK_SHIFT
        0xA2 | 0xA3 => 0x11, // VK_L/RCONTROL -> VK_CONTROL
        0xA4 | 0xA5 => 0x12, // VK_L/RMENU -> VK_MENU
        other => other,
    }
}

fn current_mods(pressed: &HashSet<u16>) -> u8 {
    let mut mods = 0;
    if pressed.contains(&0x11) {
        mods |= MOD_CTRL;
    }
    if pressed.contains(&0x10) {
        mods |= MOD_SHIFT;
    }
    if pressed.contains(&0x12) {
        mods |= MOD_ALT;
    }
    mods
}

fn handle_keyboard(vk_raw: u16, key_break: bool) {
    let vk = normalize_vk(vk_raw);
    let mut pressed_guard = PRESSED.lock().unwrap();
    let pressed = pressed_guard.get_or_insert_with(HashSet::new);
    if key_break {
        pressed.remove(&vk);
        return;
    }
    if pressed.contains(&vk) {
        return; // suppress auto-repeat until key up
    }
    pressed.insert(vk);
    let mods = current_mods(pressed);
    let config = CONFIG.get().unwrap();
    for binding in &config.keys {
        if binding.vk == vk && binding.mods == mods {
            emit_hotkey(&binding.label);
        }
    }
}

fn handle_mouse(button_flags: u16) {
    let config = CONFIG.get().unwrap();
    if config.mouse.is_empty() || button_flags == 0 {
        return;
    }
    let mods = {
        let mut pressed_guard = PRESSED.lock().unwrap();
        let pressed = pressed_guard.get_or_insert_with(HashSet::new);
        current_mods(pressed)
    };
    for binding in &config.mouse {
        if button_flags & binding.down_flag != 0 && binding.mods == mods {
            emit_hotkey(&binding.label);
        }
    }
}

/// Per-device HID state, cached on first input from the device handle.
struct HidDevice {
    ignore: bool,
    vendor: u16,
    product: u16,
    usage_page: u16,
    usage_min: u16,
    preparsed: Vec<u8>,
    prev: HashSet<u16>,
}

static HID_DEVICES: Mutex<Option<HashMap<isize, HidDevice>>> = Mutex::new(None);

fn ignored_device() -> HidDevice {
    HidDevice {
        ignore: true,
        vendor: 0,
        product: 0,
        usage_page: 0,
        usage_min: 0,
        preparsed: Vec::new(),
        prev: HashSet::new(),
    }
}

unsafe fn init_hid_device(hdevice: HANDLE) -> HidDevice {
    // Device interface path: XInput controllers carry "IG_" and are handled by
    // the XInput poller instead — skipping them here prevents double fires.
    let mut name_len = 0u32;
    GetRawInputDeviceInfoW(hdevice, RIDI_DEVICENAME, None, &mut name_len);
    let mut name_buf = vec![0u16; name_len as usize + 1];
    let copied = GetRawInputDeviceInfoW(
        hdevice,
        RIDI_DEVICENAME,
        Some(name_buf.as_mut_ptr() as *mut core::ffi::c_void),
        &mut name_len,
    );
    if copied != u32::MAX && copied > 0 {
        let name = String::from_utf16_lossy(&name_buf[..copied as usize]);
        if name.to_uppercase().contains("IG_") {
            return ignored_device();
        }
    }

    let mut info = RID_DEVICE_INFO {
        cbSize: std::mem::size_of::<RID_DEVICE_INFO>() as u32,
        ..Default::default()
    };
    let mut info_len = info.cbSize;
    if GetRawInputDeviceInfoW(
        hdevice,
        RIDI_DEVICEINFO,
        Some(&mut info as *mut _ as *mut core::ffi::c_void),
        &mut info_len,
    ) == u32::MAX
    {
        return ignored_device();
    }
    let (vendor, product) = {
        let hid = info.Anonymous.hid;
        (hid.dwVendorId as u16, hid.dwProductId as u16)
    };

    let mut pre_len = 0u32;
    GetRawInputDeviceInfoW(hdevice, RIDI_PREPARSEDDATA, None, &mut pre_len);
    if pre_len == 0 {
        return ignored_device();
    }
    let mut preparsed = vec![0u8; pre_len as usize];
    if GetRawInputDeviceInfoW(
        hdevice,
        RIDI_PREPARSEDDATA,
        Some(preparsed.as_mut_ptr() as *mut core::ffi::c_void),
        &mut pre_len,
    ) == u32::MAX
    {
        return ignored_device();
    }
    let pre_handle = PHIDP_PREPARSED_DATA(preparsed.as_ptr() as isize);

    let mut caps = HIDP_CAPS::default();
    if HidP_GetCaps(pre_handle, &mut caps).is_err() {
        return ignored_device();
    }
    let mut cap_count = caps.NumberInputButtonCaps;
    if cap_count == 0 {
        return ignored_device();
    }
    let mut button_caps = vec![HIDP_BUTTON_CAPS::default(); cap_count as usize];
    if HidP_GetButtonCaps(HidP_Input, button_caps.as_mut_ptr(), &mut cap_count, pre_handle).is_err()
    {
        return ignored_device();
    }
    // First button range: buttons on generic joysticks/pedals live on usage
    // page 0x09 ("Button"), usages numbered from UsageMin (typically 1).
    let cap = &button_caps[0];
    let usage_min = if cap.IsRange.as_bool() {
        cap.Anonymous.Range.UsageMin
    } else {
        cap.Anonymous.NotRange.Usage
    };

    HidDevice {
        ignore: false,
        vendor,
        product,
        usage_page: cap.UsagePage,
        usage_min,
        preparsed,
        prev: HashSet::new(),
    }
}

unsafe fn handle_hid(hdevice: HANDLE, size_hid: u32, count: u32, reports: &[u8]) {
    let mut devices_guard = HID_DEVICES.lock().unwrap();
    let devices = devices_guard.get_or_insert_with(HashMap::new);
    let device = devices
        .entry(hdevice.0 as isize)
        .or_insert_with(|| init_hid_device(hdevice));
    if device.ignore || size_hid == 0 {
        return;
    }
    let pre_handle = PHIDP_PREPARSED_DATA(device.preparsed.as_ptr() as isize);
    for i in 0..count as usize {
        let start = i * size_hid as usize;
        let end = start + size_hid as usize;
        if end > reports.len() {
            break;
        }
        let mut report = reports[start..end].to_vec(); // HidP wants &mut even for reads
        let mut usages = vec![0u16; 64];
        let mut usage_count = usages.len() as u32;
        let status = HidP_GetUsages(
            HidP_Input,
            device.usage_page,
            0,
            usages.as_mut_ptr(),
            &mut usage_count,
            pre_handle,
            &mut report,
        );
        if status.is_err() {
            continue;
        }
        let current: HashSet<u16> = usages[..usage_count as usize].iter().copied().collect();
        let config = CONFIG.get().unwrap();
        for usage in current.difference(&device.prev) {
            let index = usage.saturating_sub(device.usage_min);
            if config.capture {
                emit_capture_hid(device.vendor, device.product, index);
            } else {
                for binding in &config.hid {
                    if binding.vendor == device.vendor
                        && binding.product == device.product
                        && binding.index == index
                    {
                        emit_hotkey(&binding.label);
                    }
                }
            }
        }
        device.prev = current;
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        // HID input is variable-size (dwSizeHid * dwCount trailing bytes), so
        // size the buffer per message instead of using a fixed RAWINPUT.
        let mut size = 0u32;
        GetRawInputData(
            HRAWINPUT(lparam.0 as _),
            RID_INPUT,
            None,
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        );
        if size == 0 {
            return LRESULT(0);
        }
        let mut buf = vec![0u8; size as usize];
        let copied = GetRawInputData(
            HRAWINPUT(lparam.0 as _),
            RID_INPUT,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        );
        if copied == u32::MAX {
            return LRESULT(0);
        }
        let raw = &*(buf.as_ptr() as *const RAWINPUT);
        if raw.header.dwType == RIM_TYPEKEYBOARD.0 {
            let kb = raw.data.keyboard;
            handle_keyboard(kb.VKey, kb.Flags & 1 != 0); // RI_KEY_BREAK = key up
        } else if raw.header.dwType == RIM_TYPEMOUSE.0 {
            handle_mouse(raw.data.mouse.Anonymous.Anonymous.usButtonFlags);
        } else if raw.header.dwType == RIM_TYPEHID.0 {
            let hid = &raw.data.hid;
            let data_offset = (raw.data.hid.bRawData.as_ptr() as usize) - (buf.as_ptr() as usize);
            let reports = &buf[data_offset..];
            handle_hid(raw.header.hDevice, hid.dwSizeHid, hid.dwCount, reports);
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Poll XInput slots 0-3, edge-detecting button/trigger presses. Disconnected
/// slots back off (~1 s) because XInputGetState is slow for empty slots.
fn xinput_loop() {
    let config = CONFIG.get().unwrap();
    let mut prev: [Option<(u16, bool, bool)>; 4] = [None; 4];
    let mut backoff = [0u32; 4];
    loop {
        for slot in 0..4usize {
            if backoff[slot] > 0 {
                backoff[slot] -= 1;
                continue;
            }
            let mut state = XINPUT_STATE::default();
            if unsafe { XInputGetState(slot as u32, &mut state) } != 0 {
                prev[slot] = None;
                backoff[slot] = 125; // ~1 s at 8 ms/iteration
                continue;
            }
            let pad = state.Gamepad;
            let buttons = pad.wButtons.0;
            let lt = pad.bLeftTrigger > TRIGGER_THRESHOLD;
            let rt = pad.bRightTrigger > TRIGGER_THRESHOLD;
            if let Some((prev_buttons, prev_lt, prev_rt)) = prev[slot] {
                let newly = buttons & !prev_buttons;
                let mut fired: Vec<u32> = (0..16)
                    .map(|bit| 1u32 << bit)
                    .filter(|mask| newly as u32 & mask != 0)
                    .collect();
                if lt && !prev_lt {
                    fired.push(PAD_LEFT_TRIGGER);
                }
                if rt && !prev_rt {
                    fired.push(PAD_RIGHT_TRIGGER);
                }
                for code in fired {
                    if config.capture {
                        emit_capture_xinput(code);
                    } else {
                        for binding in &config.pads {
                            if binding.code == code {
                                emit_hotkey(&binding.label);
                            }
                        }
                    }
                }
            }
            prev[slot] = Some((buttons, lt, rt));
        }
        std::thread::sleep(Duration::from_millis(8));
    }
}

fn split_spec<'a>(spec: &'a str, what: &str) -> Result<(&'a str, String), String> {
    let (value, label) = spec
        .split_once('=')
        .ok_or_else(|| format!("expected <{what}>=<label>, got '{spec}'"))?;
    Ok((value, label.to_string()))
}

fn parse_u16(s: &str) -> Result<u16, String> {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16)
    } else {
        s.parse::<u16>()
    }
    .map_err(|_| format!("bad number '{s}'"))
}

fn parse_u32(s: &str) -> Result<u32, String> {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16)
    } else {
        s.parse::<u32>()
    }
    .map_err(|_| format!("bad number '{s}'"))
}

/// "VK:MODS" (":MODS" optional, e.g. legacy --vk passes just "VK").
fn parse_vk_mods(s: &str) -> Result<(u16, u8), String> {
    match s.split_once(':') {
        Some((vk, mods)) => Ok((parse_u16(vk)?, parse_u16(mods)? as u8)),
        None => Ok((parse_u16(s)?, 0)),
    }
}

fn mouse_flag(name: &str) -> Result<u16, String> {
    match name {
        "left" => Ok(RI_MOUSE_LEFT_DOWN),
        "right" => Ok(RI_MOUSE_RIGHT_DOWN),
        "middle" => Ok(RI_MOUSE_MIDDLE_DOWN),
        "x1" => Ok(RI_MOUSE_X1_DOWN),
        "x2" => Ok(RI_MOUSE_X2_DOWN),
        other => Err(format!("unknown mouse button '{other}' (left|right|middle|x1|x2)")),
    }
}

fn parse_hotkey_args(args: &[String]) -> Result<Config, String> {
    let mut config = Config::default();
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let spec = args
            .get(i + 1)
            .ok_or_else(|| format!("missing value after {flag}"))?;
        match flag {
            "--key" | "--vk" => {
                let (value, label) = split_spec(spec, "VK[:MODS]")?;
                let (vk, mods) = parse_vk_mods(value)?;
                config.keys.push(KeyBinding { vk, mods, label });
            }
            "--mouse" => {
                let (value, label) = split_spec(spec, "BTN[:MODS]")?;
                let (btn, mods) = match value.split_once(':') {
                    Some((btn, mods)) => (btn, parse_u16(mods)? as u8),
                    None => (value, 0),
                };
                config.mouse.push(MouseBinding {
                    down_flag: mouse_flag(btn)?,
                    mods,
                    label,
                });
            }
            "--pad" => {
                let (value, label) = split_spec(spec, "CODE")?;
                config.pads.push(PadBinding {
                    code: parse_u32(value)?,
                    label,
                });
            }
            "--hid" => {
                let (value, label) = split_spec(spec, "VID:PID:IDX")?;
                let parts: Vec<&str> = value.split(':').collect();
                if parts.len() != 3 {
                    return Err(format!("expected VID:PID:IDX=<label>, got '{spec}'"));
                }
                config.hid.push(HidBinding {
                    vendor: parse_u16(parts[0])?,
                    product: parse_u16(parts[1])?,
                    index: parse_u16(parts[2])?,
                    label,
                });
            }
            other => return Err(format!("unknown argument '{other}'")),
        }
        i += 2;
    }
    if config.keys.is_empty()
        && config.mouse.is_empty()
        && config.pads.is_empty()
        && config.hid.is_empty()
    {
        return Err("no bindings registered; pass at least one --key/--mouse/--pad/--hid".into());
    }
    Ok(config)
}

fn run(config: Config) -> Result<(), String> {
    eprintln!(
        "capture-helper: listening - {} key, {} mouse, {} pad, {} hid binding(s){}",
        config.keys.len(),
        config.mouse.len(),
        config.pads.len(),
        config.hid.len(),
        if config.capture { " (capture mode)" } else { "" }
    );
    let need_keyboard = !config.keys.is_empty() || !config.mouse.is_empty(); // mouse chords need modifier state
    let need_mouse = !config.mouse.is_empty();
    let need_hid = !config.hid.is_empty() || config.capture;
    let need_xinput = !config.pads.is_empty() || config.capture;
    CONFIG.set(config).ok();
    disable_eco_qos();

    if need_xinput {
        std::thread::spawn(xinput_loop);
    }

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

        let mut rids: Vec<RAWINPUTDEVICE> = Vec::new();
        let rid = |usage: u16| RAWINPUTDEVICE {
            usUsagePage: 0x01, // generic desktop
            usUsage: usage,
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        };
        if need_keyboard {
            rids.push(rid(0x06)); // keyboard
        }
        if need_mouse {
            rids.push(rid(0x02)); // mouse
        }
        if need_hid {
            rids.push(rid(0x04)); // joystick
            rids.push(rid(0x05)); // gamepad
        }
        if !rids.is_empty() {
            RegisterRawInputDevices(&rids, std::mem::size_of::<RAWINPUTDEVICE>() as u32)
                .map_err(|e| format!("RegisterRawInputDevices failed: {e}"))?;
        }

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
        Some("hotkey") => parse_hotkey_args(&args[1..]).and_then(run),
        Some("capture") => run(Config {
            capture: true,
            ..Config::default()
        }),
        _ => Err(
            "usage: capture-helper hotkey [--key VK:MODS=label] [--mouse BTN:MODS=label] \
             [--pad CODE=label] [--hid VID:PID:IDX=label] | capture-helper capture"
                .into(),
        ),
    };
    if let Err(err) = result {
        eprintln!("capture-helper: {err}");
        std::process::exit(1);
    }
}
