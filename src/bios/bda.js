// BIOS Data Area (segment 0040h, physical 0x400-0x4FF): layout constants and accessors.
import { VGA_BASE, VGA_COLS, VGA_ROWS, readMem8, writeMem8Safe, readMemWord, writeMemWord } from '../CPU8086.js';

export const BDA = {
    COM1: 0x400,
    EQUIPMENT: 0x410,       // word
    MEM_KB: 0x413,          // word: conventional memory size in KB
    KBD_FLAGS1: 0x417,      // shift / toggle state
    KBD_FLAGS2: 0x418,
    KBD_HEAD: 0x41A,        // word: head pointer (offset within the BDA segment)
    KBD_TAIL: 0x41C,        // word: tail pointer
    KBD_BUF: 0x41E,         // 16-word circular buffer
    DISK_STATUS: 0x441,     // status of the last INT 13h operation
    VIDEO_MODE: 0x449,
    COLUMNS: 0x44A,         // word
    PAGE_SIZE: 0x44C,       // word: bytes per page
    PAGE_START: 0x44E,      // word: offset of the active page
    CURSOR: 0x450,          // 8 words (col, row) per video page
    CURSOR_SHAPE: 0x460,    // word (start line, end line)
    ACTIVE_PAGE: 0x462,
    CRTC_BASE: 0x463,       // word: CRT controller base port
    TICKS: 0x46C,           // dword: timer ticks since midnight (18.2065 Hz)
    MIDNIGHT: 0x470,        // byte: set when the tick counter passed midnight
    KBD_BUF_START: 0x480,   // word: buffer start offset within the BDA segment
    KBD_BUF_END: 0x482,     // word: one past the buffer end
    ROWS_MINUS_1: 0x484,
};

// Keyboard buffer pointers are offsets relative to segment 0040h.
export const KBD_BUF_START_OFF = 0x1E;
export const KBD_BUF_END_OFF = 0x3E;

export const TEXT_PAGE_BYTES = 0x1000;          // 4 KB per 80x25 text page
export const TICKS_PER_DAY = 0x1800B0;
const TICKS_PER_SECOND = 18.2065;

export const rb = (e, addr) => readMem8(e, addr);
export const wb = (e, addr, v) => writeMem8Safe(e, addr, v);
export const rw = (e, addr) => readMemWord(e, addr);
export const ww = (e, addr, v) => writeMemWord(e, addr, v);

export const activePage = (e) => rb(e, BDA.ACTIVE_PAGE) & 7;
export const pageBase = (e, page) => VGA_BASE + (page & 7) * TEXT_PAGE_BYTES;
export const cellAddr = (e, page, row, col) => pageBase(e, page) + (row * VGA_COLS + col) * 2;

export const getCursor = (e, page = activePage(e)) => ({
    x: rb(e, BDA.CURSOR + page * 2),
    y: rb(e, BDA.CURSOR + page * 2 + 1),
});

export const setCursor = (e, x, y, page = activePage(e)) => {
    wb(e, BDA.CURSOR + page * 2, Math.min(x, VGA_COLS - 1));
    wb(e, BDA.CURSOR + page * 2 + 1, Math.min(y, VGA_ROWS - 1));
};

/** Power-on values of the BDA (what POST would leave behind). */
export const initBda = (e) => {
    ww(e, BDA.EQUIPMENT, 0x0021);       // bit0: floppy installed, bits 4-5 = 10b: 80x25 colour
    ww(e, BDA.MEM_KB, 640);
    wb(e, BDA.KBD_FLAGS1, 0);
    wb(e, BDA.KBD_FLAGS2, 0);
    ww(e, BDA.KBD_HEAD, KBD_BUF_START_OFF);
    ww(e, BDA.KBD_TAIL, KBD_BUF_START_OFF);
    ww(e, BDA.KBD_BUF_START, KBD_BUF_START_OFF);
    ww(e, BDA.KBD_BUF_END, KBD_BUF_END_OFF);
    wb(e, BDA.DISK_STATUS, 0);
    wb(e, BDA.VIDEO_MODE, 3);
    ww(e, BDA.COLUMNS, VGA_COLS);
    ww(e, BDA.PAGE_SIZE, TEXT_PAGE_BYTES);
    ww(e, BDA.PAGE_START, 0);
    for (let p = 0; p < 8; p++) { wb(e, BDA.CURSOR + p * 2, 0); wb(e, BDA.CURSOR + p * 2 + 1, 0); }
    ww(e, BDA.CURSOR_SHAPE, 0x0607);
    wb(e, BDA.ACTIVE_PAGE, 0);
    ww(e, BDA.CRTC_BASE, 0x03D4);
    wb(e, BDA.ROWS_MINUS_1, VGA_ROWS - 1);
    refreshTicks(e, Date.now());
};

/** Ticks since local midnight for a wall-clock time (ms since the epoch). */
export const ticksSinceMidnight = (nowMs) => {
    const d = new Date(nowMs);
    const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    return Math.floor(secs * TICKS_PER_SECOND);
};

/**
 * Drive the BDA tick counter from the host clock (there is no PIT/IRQ0 yet).
 * Sets the midnight flag when the counter wraps.
 */
export const refreshTicks = (e, nowMs) => {
    const prev = rw(e, BDA.TICKS) | (rw(e, BDA.TICKS + 2) << 16);
    const ticks = ticksSinceMidnight(nowMs);
    if (ticks < prev && prev > TICKS_PER_DAY - 2000) wb(e, BDA.MIDNIGHT, 1);
    ww(e, BDA.TICKS, ticks & 0xFFFF);
    ww(e, BDA.TICKS + 2, (ticks >>> 16) & 0xFFFF);
};
