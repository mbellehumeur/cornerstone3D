import type { Panel } from './types';
import { PANEL_CONFIG, PANEL_CONFIGS } from './constants';
import { PanelType } from './enums';

export type MaxTexturesPanelEntry = {
  viewportId: string;
  sourceDimensions?: [number, number, number] | null;
  activeDimensions?: [number, number, number] | null;
  downsampleScale?: number;
  maxTextureDimension3D?: number;
};

type LineSpec = {
  text: string;
  lossy?: boolean;
};

export class MaxTexturesPanel implements Panel {
  public dom: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private lastKey = '';

  constructor() {
    const config = PANEL_CONFIGS[PanelType.MAX_TEXTURES];
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

  public setContent(entries: MaxTexturesPanelEntry[]): void {
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

      const lines = formatLines(entry);
      for (const lineSpec of lines) {
        const line = document.createElement('div');
        line.textContent = lineSpec.text;
        if (lineSpec.lossy) {
          line.style.color = '#ff6b6b';
          line.style.fontWeight = '700';
        }
        row.appendChild(line);
      }
      this.list.appendChild(row);
    }
  }
}

function formatLines(entry: MaxTexturesPanelEntry): LineSpec[] {
  const source = entry.sourceDimensions;
  const active = entry.activeDimensions;
  const maxTextureLine =
    Number(entry.maxTextureDimension3D) > 0
      ? `maxTextureDimension3D ${Math.round(Number(entry.maxTextureDimension3D))}`
      : 'maxTextureDimension3D -';
  if (!source && !active) {
    return [{ text: maxTextureLine }, { text: 'resolution status: unknown' }];
  }
  if (!source && active) {
    return [
      { text: maxTextureLine },
      { text: `volume ${active.join('x')} · full resolution` },
    ];
  }
  if (!active && source) {
    return [
      { text: maxTextureLine },
      { text: `volume ${source.join('x')} · full resolution` },
    ];
  }
  const downsized =
    source![0] !== active![0] ||
    source![1] !== active![1] ||
    source![2] !== active![2];
  if (!downsized) {
    return [
      { text: maxTextureLine },
      { text: `volume ${active!.join('x')} · full resolution` },
    ];
  }
  const scale = Number(entry.downsampleScale);
  const scaleLabel =
    Number.isFinite(scale) && scale > 0 ? `${scale.toFixed(3)}x` : '?';
  return [
    { text: maxTextureLine, lossy: true },
    {
      text: `volume ${source!.join('x')} -> ${active!.join('x')} (${scaleLabel}) · lossy`,
      lossy: true,
    },
  ];
}
