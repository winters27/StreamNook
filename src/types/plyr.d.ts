declare module 'plyr' {
  export interface QualityOptions {
    default: number;
    options: number[];
    forced?: boolean;
    onChange?: (quality: number) => void;
  }

  export interface SpeedOptions {
    selected: number;
    options: number[];
  }

  export interface KeyboardOptions {
    focused?: boolean;
    global?: boolean;
  }

  export interface TooltipsOptions {
    controls?: boolean;
    seek?: boolean;
  }

  export interface I18nOptions {
    qualityLabel?: Record<number, string>;
    [key: string]: unknown;
  }

  export interface Options {
    enabled?: boolean;
    debug?: boolean;
    controls?: string[] | string;
    settings?: string[];
    quality?: QualityOptions;
    speed?: SpeedOptions;
    autoplay?: boolean;
    muted?: boolean;
    volume?: number;
    invertTime?: boolean;
    keyboard?: KeyboardOptions;
    tooltips?: TooltipsOptions;
    i18n?: I18nOptions;
    [key: string]: unknown;
  }

  class Plyr {
    constructor(target: HTMLElement | string, options?: Options);
    
    // Properties
    volume: number;
    muted: boolean;
    paused: boolean;
    playing: boolean;
    currentTime: number;
    duration: number;
    fullscreen: {
      active: boolean;
      enabled: boolean;
      enter(): void;
      exit(): void;
      toggle(): void;
    };
    pip: boolean;
    
    // Methods
    play(): Promise<void>;
    pause(): void;
    stop(): void;
    restart(): void;
    forward(seekTime?: number): void;
    rewind(seekTime?: number): void;
    togglePlay(toggle?: boolean): void;
    toggleControls(toggle?: boolean): void;
    toggleCaptions(toggle?: boolean): void;
    destroy(): void;
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback?: (...args: unknown[]) => void): void;
  }

  export default Plyr;
}
