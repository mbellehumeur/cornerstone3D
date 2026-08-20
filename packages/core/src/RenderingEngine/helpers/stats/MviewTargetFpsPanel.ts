import type { Panel } from './types';
import { PANEL_CONFIG, PANEL_CONFIGS } from './constants';
import { PanelType } from './enums';

export type MviewTargetFpsPhase = 'off' | 'ready' | 'learn' | 'steer';

export type MviewTargetFpsPanelEntry = {
  viewportId: string;
  targetFps: number;
  targeting: boolean;
  interacting: boolean;
  /** Interactive Target FPS controller phase (never still-budget). */
  phase: MviewTargetFpsPhase;
  emaFps: number;
  budgetPx: number;
  minPx: number;
  scale: number;
  steps: number;
};
type HudLineSpec = {
  text: string;
  orange?: boolean;
};

/**
 * Text panel for mview Target FPS / pixel-budget steering (Cornerstone stats overlay).
 * Theme matches Max textures (blue).
 */
export class MviewTargetFpsPanel implements Panel {
  public dom: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private lastKey = '';

  constructor() {
    const config = PANEL_CONFIGS[PanelType.MVIEW_TARGET_FPS];
    this.dom = document.createElement('div');
    this.dom.style.cssText = `
      width:280px;
      max-width:calc(100vw - ${PANEL_CONFIG.WIDTH + 24}px);
      min-width:0;
      min-height:${PANEL_CONFIG.HEIGHT}px;
      background:${config.backgroundColor};
      color:${config.foregroundColor};
      font:${PANEL_CONFIG.FONT_SIZE + 2}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      padding:8px;
      box-sizing:border-box;
      max-height:min(320px, calc(100vh - 16px));
      overflow:auto;
      border:1px solid rgba(117, 184, 255, 0.45);
      border-radius:4px;
      box-shadow:0 8px 28px rgba(0, 0, 0, 0.35);
    `;

    const title = document.createElement('div');
    title.textContent = config.name;
    title.style.cssText = `
      margin-bottom:8px;
      font-weight:700;
      letter-spacing:0.08em;
      text-transform:uppercase;
    `;
    this.dom.appendChild(title);

    this.list = document.createElement('div');
    this.list.style.cssText = `
      display:flex;
      flex-direction:column;
      gap:6px;
      line-height:1.4;
      font-weight:normal;
      color:#d7ebff;
    `;
    this.dom.appendChild(this.list);
  }

  public update(): void {
    // Content is pushed from StatsOverlay via setContent().
  }

  public setContent(entries: MviewTargetFpsPanelEntry[]): void {
    const key = JSON.stringify(entries);
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    this.list.replaceChildren();

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.textContent = '(no mview Volume3D)';
      empty.style.opacity = '0.7';
      this.list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.style.cssText = `
        padding:7px;
        background:rgba(0, 0, 0, 0.22);
        border:1px solid rgba(117, 184, 255, 0.22);
        border-radius:4px;
        display:flex;
        flex-direction:column;
        gap:2px;
      `;

      // ready waits idle; only the active learn window shows "learning" (orange).
      const learning = entry.phase === 'learn';
      const interactionLabel = learning
        ? 'learning'
        : entry.interacting
          ? 'drag'
          : 'idle';
      const lines: HudLineSpec[] = !entry.targeting
        ? [
            { text: 'target FPS off' },
            { text: `min pixel budget: ${formatBudget(entry.minPx)}` },
            { text: interactionLabel, orange: learning },
            { text: `interact budget ${formatBudget(entry.budgetPx)}` },
          ]
        : [
            { text: `target: ${entry.targetFps} fps` },
            { text: `min pixel budget: ${formatBudget(entry.minPx)}` },
            { text: `measured fps: ${entry.emaFps.toFixed(1)}` },
            { text: `interact budget ${formatBudget(entry.budgetPx)}` },
            {
              text: `scale ${entry.scale.toFixed(2)} · steps ${entry.steps}`,
            },
            { text: interactionLabel, orange: learning },
          ];

      for (const lineSpec of lines) {
        const line = document.createElement('div');
        line.textContent = lineSpec.text;
        if (lineSpec.orange) {
          line.style.color = '#ff9800';
          line.style.fontWeight = '700';
        }
        row.appendChild(line);
      }
      this.list.appendChild(row);
    }
  }
}

function formatBudget(pixels: number): string {
  if (pixels >= 1_000_000) {
    return `${(pixels / 1_000_000).toFixed(2)}MP`;
  }
  if (pixels >= 1_000) {
    return `${Math.round(pixels / 1_000)}k`;
  }
  return `${Math.round(pixels)}`;
}
