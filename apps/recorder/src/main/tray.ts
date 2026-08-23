/**
 * Tray presence. During a session this is the ONLY UI: all BrowserWindows are
 * closed (not hidden — Electron has documented hidden-window GPU regressions,
 * perf report §4.2), leaving a renderer-free main process + this tray icon.
 */
import { Menu, nativeImage, Tray } from 'electron';

export interface TrayHandlers {
  onShow: () => void;
  onMark: () => void;
  onStop: () => void;
  onQuit: () => void;
}

/** 16×16 filled circle as raw BGRA (what createFromBitmap expects on Windows). */
function circleIcon(b: number, g: number, r: number): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = 6.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) {
        const i = (y * size + x) * 4;
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = d > radius - 1 ? Math.round(255 * (radius - d)) : 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export class RecorderTray {
  private tray: Tray;
  private idleIcon = circleIcon(160, 160, 160);
  private recordingIcon = circleIcon(48, 48, 230);
  private recording = false;
  private markHotkeyLabel = 'F8';

  constructor(private readonly handlers: TrayHandlers) {
    this.tray = new Tray(this.idleIcon);
    this.tray.setToolTip('Playtest Recorder');
    this.tray.on('double-click', () => this.handlers.onShow());
    this.rebuildMenu();
  }

  setMarkHotkeyLabel(label: string): void {
    this.markHotkeyLabel = label;
    this.rebuildMenu();
  }

  setRecording(recording: boolean): void {
    this.recording = recording;
    this.tray.setImage(recording ? this.recordingIcon : this.idleIcon);
    if (!recording) this.tray.setToolTip('Playtest Recorder — idle');
    this.rebuildMenu();
  }

  setTooltip(text: string): void {
    this.tray.setToolTip(text);
  }

  private rebuildMenu(): void {
    const menu = Menu.buildFromTemplate([
      {
        label: this.recording ? 'Recording…' : 'Playtest Recorder',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: `Mark (${this.markHotkeyLabel})`,
        enabled: this.recording,
        click: () => this.handlers.onMark(),
      },
      {
        label: 'Stop recording',
        enabled: this.recording,
        click: () => this.handlers.onStop(),
      },
      { type: 'separator' },
      { label: 'Show window', enabled: !this.recording, click: () => this.handlers.onShow() },
      { label: 'Quit', click: () => this.handlers.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
