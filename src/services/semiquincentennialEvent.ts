// Semiquincentennial (July 4, 2026): shared constants for the 250th-anniversary
// event. The accolade grants server-side via the rewards row of the same id;
// the launch celebration shows locally on the Fourth.

export const SEMIQUINCENTENNIAL_ACCOLADE_ID = 'semiquincentennial_2026';

// The celebration auto-plays on July 4, 2026 local time (the grant window is
// wider, July 3-5, enforced by the server; this only gates the launch show).
export const isSemiquincentennialShowDay = (date: Date = new Date()): boolean =>
  date.getFullYear() === 2026 && date.getMonth() === 6 && date.getDate() === 4;


// One auto-play per install; replays stay available from the celebration modal.
export const SEMIQUINCENTENNIAL_SHOWN_KEY = 'streamnook_semiquincentennial_shown_v1';

// Reopen the show from anywhere in the UI (e.g. the title-bar button) while
// the celebration day is active. The overlay component listens for this.
export const SEMIQUINCENTENNIAL_OPEN_EVENT = 'sn-semiquincentennial-open';

export const openSemiquincentennialShow = (): void => {
  window.dispatchEvent(new CustomEvent(SEMIQUINCENTENNIAL_OPEN_EVENT));
};

// Secret accolade: accumulate a minute of total show watch time, across as
// many viewings as it takes. Tracked client-side like the other secrets.
export const GRAND_FINALE_ACCOLADE_ID = 'grand_finale_2026';
export const GRAND_FINALE_THRESHOLD_MS = 60_000;
export const GRAND_FINALE_WATCH_MS_KEY = 'streamnook_grand_finale_watch_ms_v1';
export const GRAND_FINALE_GRANTED_KEY = 'streamnook_grand_finale_granted_v1';
