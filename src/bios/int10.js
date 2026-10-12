// INT 10h — video services (80x25 colour text mode).
// Reference: http://www.techhelpmanual.com/95-interrupts_and_bios_services.html
//
// Behaviour follows the IBM/VGA BIOS: the cursor and mode live in the BIOS Data Area, blanks are
// SPACE (0x20) with the requested attribute, teletype output keeps the attribute already on screen,
// and scrolling is clamped to the requested window.
import { VGA_COLS, VGA_ROWS, readMem8, writeMem8Safe } from '../CPU8086.js';
import {
    BDA, TEXT_PAGE_BYTES, rb, wb, ww, activePage, pageBase, cellAddr, getCursor, setCursor,
} from './bda.js';

const DEFAULT_ATTR = 0x07;
const BLANK = 0x20;

const hi = (v) => (v >> 8) & 0xFF;
const lo = (v) => v & 0xFF;
const setAL = (e, v) => { e.reg.AX = (e.reg.AX & 0xFF00) | (v & 0xFF); };

const putCell = (e, page, row, col, ch, attr) => {
    const a = cellAddr(e, page, row, col);
    writeMem8Safe(e, a, ch);
    if (attr !== null) writeMem8Safe(e, a + 1, attr);
};

const clearPage = (e, page, attr = DEFAULT_ATTR) => {
    const base = pageBase(e, page);
    for (let i = 0; i < VGA_COLS * VGA_ROWS * 2; i += 2) {
        writeMem8Safe(e, base + i, BLANK);
        writeMem8Safe(e, base + i + 1, attr);
    }
};

/** Scroll a window up (dir=+1) or down (dir=-1); `lines` of 0 or >= height clears it. */
export const scrollWindow = (e, dir, lines, attr, top, left, bottom, right, page = activePage(e)) => {
    bottom = Math.min(bottom, VGA_ROWS - 1);
    right = Math.min(right, VGA_COLS - 1);
    if (top > bottom || left > right) return;
    const height = bottom - top + 1;
    const blankRow = (r) => { for (let c = left; c <= right; c++) putCell(e, page, r, c, BLANK, attr); };
    if (lines === 0 || lines >= height) {
        for (let r = top; r <= bottom; r++) blankRow(r);
        return;
    }
    const copyRow = (from, to) => {
        for (let c = left; c <= right; c++) {
            const s = cellAddr(e, page, from, c); const d = cellAddr(e, page, to, c);
            writeMem8Safe(e, d, readMem8(e, s)); writeMem8Safe(e, d + 1, readMem8(e, s + 1));
        }
    };
    if (dir > 0) {
        for (let r = top; r <= bottom - lines; r++) copyRow(r + lines, r);
        for (let r = bottom - lines + 1; r <= bottom; r++) blankRow(r);
    } else {
        for (let r = bottom; r >= top + lines; r--) copyRow(r - lines, r);
        for (let r = top; r < top + lines; r++) blankRow(r);
    }
};

/**
 * Teletype one character at the cursor (control characters handled), scrolling at the bottom.
 * `attr` null keeps the attribute already in the cell.
 */
const teletype = (e, ch, attr, page) => {
    let { x, y } = getCursor(e, page);
    if (ch === 0x07) return; // BEL
    if (ch === 0x08) { if (x > 0) x--; }
    else if (ch === 0x0A) { y++; }
    else if (ch === 0x0D) { x = 0; }
    else {
        putCell(e, page, y, x, ch, attr);
        x++;
        if (x >= VGA_COLS) { x = 0; y++; }
    }
    if (y >= VGA_ROWS) {
        scrollWindow(e, 1, 1, DEFAULT_ATTR, 0, 0, VGA_ROWS - 1, VGA_COLS - 1, page);
        y = VGA_ROWS - 1;
    }
    setCursor(e, x, y, page);
};

/** Write `count` copies starting at the cursor, wrapping across rows; the cursor does not move. */
const writeRepeated = (e, ch, attr, count, page) => {
    let { x, y } = getCursor(e, page);
    for (let i = 0; i < count; i++) {
        if (y >= VGA_ROWS) break;
        putCell(e, page, y, x, ch, attr);
        x++;
        if (x >= VGA_COLS) { x = 0; y++; }
    }
};

export const clearScreen = (e) => {
    for (let p = 0; p < 8; p++) clearPage(e, p);
};

export const int10 = (e) => {
    const ah = hi(e.reg.AX); const al = lo(e.reg.AX);
    const bh = hi(e.reg.BX); const bl = lo(e.reg.BX);
    const ch = hi(e.reg.CX); const cl = lo(e.reg.CX);
    const dh = hi(e.reg.DX); const dl = lo(e.reg.DX);
    const page = activePage(e);

    switch (ah) {
        case 0x00: { // set video mode (bit 7 of AL: keep the screen contents)
            wb(e, BDA.VIDEO_MODE, al & 0x7F);
            if (!(al & 0x80)) clearScreen(e);
            for (let p = 0; p < 8; p++) setCursor(e, 0, 0, p);
            wb(e, BDA.ACTIVE_PAGE, 0);
            ww(e, BDA.PAGE_START, 0);
            break;
        }
        case 0x01: ww(e, BDA.CURSOR_SHAPE, e.reg.CX); break; // set cursor shape
        case 0x02: setCursor(e, dl, dh, bh & 7); break;      // set cursor position
        case 0x03: { // get cursor position and shape
            const c = getCursor(e, bh & 7);
            e.reg.DX = (c.y << 8) | c.x;
            e.reg.CX = rb(e, BDA.CURSOR_SHAPE) | (rb(e, BDA.CURSOR_SHAPE + 1) << 8);
            break;
        }
        case 0x05: // select active page
            wb(e, BDA.ACTIVE_PAGE, al & 7);
            ww(e, BDA.PAGE_START, (al & 7) * TEXT_PAGE_BYTES);
            break;
        case 0x06: scrollWindow(e, 1, al, bh, ch, cl, dh, dl, page); break;   // scroll up
        case 0x07: scrollWindow(e, -1, al, bh, ch, cl, dh, dl, page); break;  // scroll down
        case 0x08: { // read character and attribute at the cursor
            const c = getCursor(e, bh & 7);
            const a = cellAddr(e, bh & 7, c.y, c.x);
            e.reg.AX = (readMem8(e, a + 1) << 8) | readMem8(e, a);
            break;
        }
        case 0x09: writeRepeated(e, al, bl, e.reg.CX, bh & 7); break;       // write char + attribute
        case 0x0A: writeRepeated(e, al, null, e.reg.CX, bh & 7); break;     // write char only
        case 0x0E: teletype(e, al, null, page); break;                       // teletype output
        case 0x0F: // get video mode
            e.reg.AX = (VGA_COLS << 8) | rb(e, BDA.VIDEO_MODE);
            e.reg.BX = (page << 8) | bl;
            break;
        case 0x13: { // write string: ES:BP, CX chars, BL attribute, DH/DL start
            const startPage = bh & 7;
            const saved = getCursor(e, startPage);
            setCursor(e, dl, dh, startPage);
            let addr = ((e.reg.ES << 4) + e.reg.BP) & 0xFFFFF;
            for (let i = 0; i < e.reg.CX; i++) {
                const c = readMem8(e, addr++);
                let attr = bl;
                if (al & 0x02) attr = readMem8(e, addr++);
                teletype(e, c, attr, startPage);
            }
            if (!(al & 0x01)) setCursor(e, saved.x, saved.y, startPage);
            break;
        }
        case 0x1A: // get display combination code
            if (al === 0) { setAL(e, 0x1A); e.reg.BX = 0x0008; } // VGA with analog colour display
            break;
        default:
            break; // unsupported subfunctions leave the registers untouched, like the real BIOS
    }
};
